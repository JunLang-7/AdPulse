import type { Candidate } from "./ports/policyEngine.js";
import type { Storage, Transaction } from "./ports/storage.js";
import { isMetricKeyForPlacement, placementSpec, type PlacementMetricKey } from "./domain/placement.js";
import type {
	Session,
	TaskVersion,
	ValidationCheck,
} from "./state/model.js";

const MS_PER_DAY = 86_400_000;

/**
 * 只有任务口径完整时才建检查点：没有明确指标、窗口与阈值，
 * 到期也无法判断「达标/未达标」，不如不建，避免制造假验证。
 *
 * 指标键必须与任务的投放方式口径一致（付费广告 = 单次咨询成本，
 * 达人/种草 = 单次互动成本）；不一致说明口径本身矛盾，不建检查点。
 */
export function validationRulesComplete(
	taskVersion: TaskVersion | null,
): taskVersion is TaskVersion & {
	rules: TaskVersion["rules"] & {
		metricKey: PlacementMetricKey;
		currency: string;
		unit: string;
		statWindowDays: number;
		alertThresholdMinor: number;
		minimumSpendMinor: number;
		minimumConsultations: number;
	};
} {
	const rules = taskVersion?.rules;
	return Boolean(
		rules &&
			rules.metricKey !== undefined &&
			isMetricKeyForPlacement(rules.metricKey, rules.placementType) &&
			rules.currency &&
			rules.unit &&
			rules.statWindowDays !== undefined &&
			rules.statWindowDays > 0 &&
			rules.alertThresholdMinor !== undefined &&
			rules.minimumSpendMinor !== undefined &&
			rules.minimumConsultations !== undefined,
	);
}

/**
 * 接受候选时在同一事务内创建检查点。重复执行同一选择不会重复创建，
 * 也不会重复排队；没有验证计划、没有实际变更或口径不完整时返回 null。
 */
export async function createValidationCheckIn(
	tx: Transaction,
	input: {
		session: Session;
		candidate: Candidate;
		snapshotVersion: number;
		at: string;
	},
): Promise<ValidationCheck | null> {
	const { session, candidate, snapshotVersion, at } = input;
	if (!session.taskRef || !candidate.validationPlan || candidate.changes.length === 0)
		return null;
	const task = await tx.tasks.get(session.taskRef.taskId);
	const taskVersion = await tx.taskVersions.get(
		`${session.taskRef.taskId}:${session.taskRef.taskVersion}`,
	);
	if (!task || task.ownerId !== session.ownerId || task.deletion) return null;
	if (!validationRulesComplete(taskVersion)) return null;

	const id = `${session.id}:${snapshotVersion}`;
	const existing = await tx.validationChecks.get(id);
	if (existing) return existing;

	const check: ValidationCheck = {
		id,
		ownerId: session.ownerId,
		taskId: task.id,
		taskVersion: taskVersion.version,
		sessionId: session.id,
		snapshotVersion,
		...(candidate.hypothesis ? { hypothesis: candidate.hypothesis } : {}),
		validationPlan: candidate.validationPlan,
		// 记录任务自己的口径键，不写死付费广告的指标名。
		metricKey: taskVersion.rules.metricKey,
		dueAt: new Date(
			Date.parse(at) + taskVersion.rules.statWindowDays * MS_PER_DAY,
		).toISOString(),
		status: "pending",
		createdAt: at,
	};
	await tx.validationChecks.put(check);
	// 任务在 dueAt 才可领取；到期前 worker 不会提前评估。
	await tx.jobs.put({
		id: `validation:${id}`,
		task: { kind: "evaluate_validation_check", checkId: id },
		status: "pending",
		runAt: check.dueAt,
		attempts: 0,
	});
	return check;
}

export class ValidationCheckError extends Error {
	constructor(
		readonly status: 404 | 409,
		message: string,
	) {
		super(message);
		this.name = "ValidationCheckError";
	}
}

/**
 * 到期评估：只把「同一任务版本、接受之后产生、可评估」的最新比较结果关联到检查点。
 * 不推断因果，也不修改策略；没有可比证据就如实记为 inconclusive。
 */
export class ValidationCheckService {
	constructor(
		private readonly storage: Storage,
		private readonly now: () => string = () => new Date().toISOString(),
	) {}

	/**
	 * 补证后的人工重评：只允许 owner 对 inconclusive 检查点重试，
	 * 重新查找接受之后的比较结果；observed 是终态，不回退。
	 */
	async reevaluate(ownerId: string, checkId: string): Promise<ValidationCheck> {
		const pending = await this.storage.transaction(async (tx) => {
			const current = await tx.validationChecks.get(checkId);
			if (!current || current.ownerId !== ownerId)
				throw new ValidationCheckError(404, "validation check not found");
			if (current.status !== "inconclusive")
				throw new ValidationCheckError(
					409,
					"only inconclusive checks can be re-evaluated",
				);
			const next: ValidationCheck = {
				id: current.id,
				ownerId: current.ownerId,
				taskId: current.taskId,
				taskVersion: current.taskVersion,
				sessionId: current.sessionId,
				snapshotVersion: current.snapshotVersion,
				...(current.hypothesis ? { hypothesis: current.hypothesis } : {}),
				validationPlan: current.validationPlan,
				metricKey: current.metricKey,
				dueAt: current.dueAt,
				status: "pending",
				createdAt: current.createdAt,
			};
			await tx.validationChecks.put(next);
			return next;
		});
		await this.evaluate(pending.id);
		const result = await this.storage.transaction((tx) =>
			tx.validationChecks.get(pending.id),
		);
		if (!result)
			throw new ValidationCheckError(404, "validation check not found");
		return result;
	}

	async evaluate(checkId: string): Promise<void> {
		await this.storage.transaction(async (tx) => {
			const check = await tx.validationChecks.get(checkId);
			if (!check || check.status !== "pending") return;
			const at = this.now();
			const markInconclusive = async (reason: string) => {
				await tx.validationChecks.put({
					...check,
					status: "inconclusive",
					reason,
					observedAt: at,
				});
			};

			const task = await tx.tasks.get(check.taskId);
			if (!task) return markInconclusive("task_not_found");
			if (task.deletion) return markInconclusive("task_deleted");
			if (task.currentVersion !== check.taskVersion)
				return markInconclusive("task_version_changed");

			const result = (await tx.comparisonResults.all())
				.filter(
					(row) =>
						row.ownerId === check.ownerId &&
						row.taskId === check.taskId &&
						row.rulesRef.version === check.taskVersion &&
						row.createdAt >= check.createdAt &&
						row.canEvaluateCurrentThreshold &&
						row.thresholdEvaluation.status !== "not_evaluated",
				)
				.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
				.at(-1);
			if (!result) return markInconclusive("no_comparable_evidence");

			await tx.validationChecks.put({
				...check,
				status: "observed",
				comparisonResultId: result.id,
				evidenceRef: {
					evidenceId: result.current.evidenceId,
					version: result.current.version,
				},
				observedOutcome:
					result.thresholdEvaluation.status === "exceeded"
						? "above_threshold"
						: "below_threshold",
				observedAt: at,
			});
		});
	}
}
