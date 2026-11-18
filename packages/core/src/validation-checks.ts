import type { Candidate } from "./ports/policyEngine.js";
import type { Storage, Transaction } from "./ports/storage.js";
import type {
	Session,
	TaskVersion,
	ValidationCheck,
} from "./state/model.js";

const MS_PER_DAY = 86_400_000;

/**
 * 只有任务口径完整时才建检查点：没有明确指标、窗口与阈值，
 * 到期也无法判断「达标/未达标」，不如不建，避免制造假验证。
 */
export function validationRulesComplete(
	taskVersion: TaskVersion | null,
): taskVersion is TaskVersion & {
	rules: TaskVersion["rules"] & {
		metricKey: "cost_per_consultation";
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
			rules.metricKey === "cost_per_consultation" &&
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
		metricKey: "cost_per_consultation",
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

/**
 * 到期评估：只把「同一任务版本、接受之后产生、可评估」的最新比较结果关联到检查点。
 * 不推断因果，也不修改策略；没有可比证据就如实记为 inconclusive。
 */
export class ValidationCheckService {
	constructor(
		private readonly storage: Storage,
		private readonly now: () => string = () => new Date().toISOString(),
	) {}

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
