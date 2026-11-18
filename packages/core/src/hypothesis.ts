// 假设偏差（README 第三类信号）：当前方案依赖的判断被新证据支持或挑战。
//
// 三条不变量：
// 1) 只有用户确认的判定（stage=confirmed）能改变假设状态；
//    模型初判只进入待确认队列（stage=preliminary），驳回即终态留痕。
// 2) 写路径幂等：create/revise/retire/verdict 走 operation 去重（ownerId + key），
//    判定对同一 (假设, 证据主体) 只保留一条未驳回判定（dedupKey）。
// 3) 任务到期即限访：到期/已删任务的假设不可读、不可写、不参与通知。
import { createHash } from "node:crypto";
import { taskActiveIn } from "./lifecycle.js";
import { NotificationSelectionService } from "./notifications-selection.js";
import type { Storage, Transaction } from "./ports/storage.js";
import type {
	Hypothesis,
	HypothesisVersion,
	HypothesisJudgment,
	HypothesisOrigin,
	HypothesisStatus,
	HypothesisSubjectRef,
	HypothesisVerdict,
	HypothesisVerdictStage,
} from "./state/model.js";

export interface HypothesisCreateInput {
	taskId: string;
	/** 缺省取任务当前版本；显式传入时必须已存在。 */
	taskVersion?: number;
	statement: string;
	rationale: string;
	testable?: string;
	origin: HypothesisOrigin;
	/** origin=model_draft_accepted 时的草案留痕。 */
	draftRef?: { modelRef: string; generatedAt: string; iterations: number };
}

export interface HypothesisReviseInput {
	statement: string;
	rationale: string;
	testable?: string;
}

export interface HypothesisVerdictInput {
	subject: HypothesisSubjectRef;
	judgment: HypothesisJudgment;
	explanation: string;
	quote?: string;
	/** 自动初判留痕；人工判定缺省。 */
	preliminary?: { modelRef: string; generatedAt: string };
}

export interface HypothesisOperationResult {
	status: "created" | "duplicate" | "revised" | "unchanged" | "retired"
		| "verdict_recorded" | "verdict_duplicate";
	hypothesis?: Hypothesis;
	version?: HypothesisVersion;
	verdict?: HypothesisVerdict;
}

export class HypothesisError extends Error {
	constructor(readonly status: 400 | 404 | 409, message: string) { super(message); }
}
const fail = (message: string): never => { throw new HypothesisError(400, message); };
const normalize = (value: string) => value.normalize("NFKC").trim();
const canonical = (v: unknown): string => JSON.stringify(v, (_k, item) =>
	item && typeof item === "object" && !Array.isArray(item)
		? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
const hash = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");
const text = (v: unknown, max: number): v is string =>
	typeof v === "string" && !!v.trim() && v.trim().length <= max;

const statementMax = 200;
const rationaleMax = 500;
const testableMax = 400;
const explanationMax = 1000;
const quoteMax = 2000;

const validSubject = (subject: HypothesisSubjectRef): boolean => {
	if (!subject || typeof subject !== "object") return false;
	if (subject.kind === "market_event")
		return text(subject.eventId, 256) && Number.isSafeInteger(subject.version) && subject.version >= 1;
	if (subject.kind === "source_item") return text(subject.sourceItemId, 256);
	if (subject.kind === "comparison") return text(subject.comparisonResultId, 256);
	return false;
};

const subjectKey = (subject: HypothesisSubjectRef): string => hash(subject);

function validateContent(input: { statement: string; rationale: string; testable?: string }): void {
	if (!text(input.statement, statementMax)) fail(`invalid statement (1-${statementMax} chars)`);
	if (!text(input.rationale, rationaleMax)) fail(`invalid rationale (1-${rationaleMax} chars)`);
	if (input.testable !== undefined && !text(input.testable, testableMax)) fail(`invalid testable (<=${testableMax} chars)`);
}

export interface HypothesisDetail {
	head: Hypothesis;
	current: HypothesisVersion;
	versions: HypothesisVersion[];
	verdicts: HypothesisVerdict[];
}

export class HypothesisService {
	private readonly selections: NotificationSelectionService;
	constructor(
		private readonly storage: Storage,
		private readonly now: () => string = () => new Date().toISOString(),
	) {
		this.selections = new NotificationSelectionService(storage, now);
	}

	private async activeHeadIn(tx: Transaction, ownerId: string, hypothesisId: string): Promise<Hypothesis | null> {
		const head = await tx.hypotheses.get(hypothesisId);
		if (!head || head.ownerId !== ownerId) return null;
		const task = await tx.tasks.get(head.taskId);
		if (!task || task.ownerId !== ownerId) return null;
		if (!await taskActiveIn(tx, task, new Date(this.now()))) return null;
		return head;
	}

	private async currentVersionIn(tx: Transaction, head: Hypothesis): Promise<HypothesisVersion> {
		const version = await tx.hypothesisVersions.get(`${head.id}:${head.currentVersion}`);
		if (!version) throw new HypothesisError(409, "hypothesis version missing");
		return version;
	}

	async list(ownerId: string, taskId: string): Promise<HypothesisDetail[]> {
		if (!text(ownerId, 256) || !text(taskId, 128)) fail("invalid owner or task");
		return this.storage.transaction(async tx => {
			const task = await tx.tasks.get(taskId);
			if (!task || task.ownerId !== ownerId || !await taskActiveIn(tx, task, new Date(this.now()))) return [];
			const heads = (await tx.hypotheses.listByOwner(ownerId)).filter(h => h.taskId === taskId);
			const out: HypothesisDetail[] = [];
			for (const head of heads.sort((a, b) => b.createdAt.localeCompare(a.createdAt))) {
				const current = await tx.hypothesisVersions.get(`${head.id}:${head.currentVersion}`);
				if (!current) continue;
				out.push({ head, current, versions: [current], verdicts: [] });
			}
			return out;
		});
	}

	async detail(ownerId: string, hypothesisId: string): Promise<HypothesisDetail | null> {
		if (!text(ownerId, 256) || !text(hypothesisId, 256)) fail("invalid owner or hypothesis");
		return this.storage.transaction(async tx => {
			const head = await this.activeHeadIn(tx, ownerId, hypothesisId);
			if (!head) return null;
			const versions = (await tx.hypothesisVersions.listByOwner(ownerId))
				.filter(v => v.hypothesisId === hypothesisId)
				.sort((a, b) => b.version - a.version);
			const current = versions[0];
			if (!current) return null;
			const verdicts = (await tx.hypothesisVerdicts.listByOwner(ownerId))
				.filter(v => v.hypothesisId === hypothesisId)
				.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
			return { head, current, versions, verdicts };
		});
	}

	/** 待确认初判列表：初判确认/驳回的入口按 owner 过滤。 */
	async pendingVerdicts(ownerId: string, taskId?: string): Promise<HypothesisVerdict[]> {
		return this.storage.transaction(async tx => {
			const heads = new Map((await tx.hypotheses.listByOwner(ownerId)).map(h => [h.id, h]));
			const out: HypothesisVerdict[] = [];
			for (const verdict of (await tx.hypothesisVerdicts.listByOwner(ownerId))
				.filter(v => v.stage === "preliminary")) {
				const head = heads.get(verdict.hypothesisId);
				if (!head) continue;
				if (taskId && head.taskId !== taskId) continue;
				const task = await tx.tasks.get(head.taskId);
				if (!task || !await taskActiveIn(tx, task, new Date(this.now()))) continue;
				out.push(verdict);
			}
			return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
		});
	}

	async create(ownerId: string, key: string, input: HypothesisCreateInput) {
		validateContent(input);
		if (input.origin !== "manual" && input.origin !== "model_draft_accepted") fail("invalid origin");
		if (input.origin === "model_draft_accepted") {
			const ref = input.draftRef;
			if (!ref || !text(ref.modelRef, 256) || !text(ref.generatedAt, 40)
				|| !Number.isSafeInteger(ref.iterations) || ref.iterations < 0) fail("draft reference required");
		} else if (input.draftRef !== undefined) {
			fail("manual hypothesis cannot carry a draft reference");
		}
		if (input.taskVersion !== undefined && (!Number.isSafeInteger(input.taskVersion) || input.taskVersion < 1))
			fail("invalid task version");
		return this.mutate(ownerId, tx => this.commitCreate(tx, ownerId, key, input));
	}

	async revise(ownerId: string, hypothesisId: string, key: string, expectedVersion: number, input: HypothesisReviseInput) {
		validateContent(input);
		if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) fail("invalid expected version");
		return this.mutate(ownerId, tx => this.commitRevise(tx, ownerId, hypothesisId, key, expectedVersion, input));
	}

	async retire(ownerId: string, hypothesisId: string, key: string, expectedVersion: number) {
		if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) fail("invalid expected version");
		return this.mutate(ownerId, tx => this.commitRetire(tx, ownerId, hypothesisId, key, expectedVersion));
	}

	/** 人工判定：立即 confirmed，supports/challenges 直接改变状态。 */
	async verdict(ownerId: string, hypothesisId: string, key: string, input: HypothesisVerdictInput) {
		if (!text(input.explanation, explanationMax)) fail(`invalid explanation (1-${explanationMax} chars)`);
		if (input.quote !== undefined && !text(input.quote, quoteMax)) fail(`invalid quote (<=${quoteMax} chars)`);
		if (!["supports", "challenges", "unclear"].includes(input.judgment)) fail("invalid judgment");
		if (!validSubject(input.subject)) fail("invalid subject");
		if (input.preliminary !== undefined) fail("manual verdict cannot carry a preliminary mark");
		return this.mutate(ownerId, tx => this.commitVerdict(tx, ownerId, hypothesisId, key, input));
	}

	/** 确认初判：supports/challenges 在此改变状态（提案 §5.3）。 */
	async confirmVerdict(ownerId: string, verdictId: string): Promise<{ verdict: HypothesisVerdict; hypothesis: Hypothesis }> {
		if (!text(ownerId, 256) || !text(verdictId, 256)) fail("invalid owner or verdict");
		// 与其他写路径共用 owner 级互斥：确认/驳回不得与修订/停用并发穿插。
		return this.mutate(ownerId, tx => this.commitConfirmVerdict(tx, ownerId, verdictId));
	}

	private async commitConfirmVerdict(
		tx: Transaction, ownerId: string, verdictId: string,
	): Promise<{ verdict: HypothesisVerdict; hypothesis: Hypothesis }> {
		const verdict = await tx.hypothesisVerdicts.get(verdictId);
		if (!verdict || verdict.ownerId !== ownerId) throw new HypothesisError(404, "verdict not found");
		if (verdict.stage === "rejected") throw new HypothesisError(409, "verdict already rejected");
		if (verdict.stage === "confirmed") {
			const head = await this.activeHeadIn(tx, ownerId, verdict.hypothesisId);
			if (!head) throw new HypothesisError(404, "hypothesis not found");
			return { verdict, hypothesis: head };
		}
		const head = await this.activeHeadIn(tx, ownerId, verdict.hypothesisId);
		if (!head) throw new HypothesisError(404, "hypothesis not found");
		// 已停用的假设不再接受判定确认：否则会「静默确认但无状态变更、无提醒」。
		if (head.status === "retired") throw new HypothesisError(409, "hypothesis retired");
		if (head.currentVersion !== verdict.hypothesisVersion) throw new HypothesisError(409, "hypothesis version conflict");
		const confirmed: HypothesisVerdict = { ...verdict, stage: "confirmed", confirmedAt: this.now() };
		await tx.hypothesisVerdicts.put(confirmed);
		const head2 = this.applyJudgment(head, confirmed.judgment);
		await tx.hypotheses.put(head2);
		// 状态变更即进本人订阅筛选（S5）：模拟来源与 unclear 不会入队，只留筛选记录。
		if (head2 !== head && confirmed.judgment !== "unclear")
			await this.selections.selectHypothesisVerdictIn(tx, confirmed, head2);
		return { verdict: confirmed, hypothesis: head2 };
	}

	/** 驳回初判：终态留痕，不改状态、不提醒。 */
	async rejectVerdict(ownerId: string, verdictId: string): Promise<{ verdict: HypothesisVerdict; hypothesis: Hypothesis }> {
		if (!text(ownerId, 256) || !text(verdictId, 256)) fail("invalid owner or verdict");
		return this.mutate(ownerId, tx => this.commitRejectVerdict(tx, ownerId, verdictId));
	}

	private async commitRejectVerdict(
		tx: Transaction, ownerId: string, verdictId: string,
	): Promise<{ verdict: HypothesisVerdict; hypothesis: Hypothesis }> {
		const verdict = await tx.hypothesisVerdicts.get(verdictId);
		if (!verdict || verdict.ownerId !== ownerId) throw new HypothesisError(404, "verdict not found");
		if (verdict.stage === "confirmed") throw new HypothesisError(409, "confirmed verdict cannot be rejected");
		if (verdict.stage === "rejected") {
			const head = await this.activeHeadIn(tx, ownerId, verdict.hypothesisId);
			if (!head) throw new HypothesisError(404, "hypothesis not found");
			return { verdict, hypothesis: head };
		}
		// 驳回不改状态；confirmedAt 只表示确认时刻，因此不写。
		const rejected: HypothesisVerdict = { ...verdict, stage: "rejected" };
		await tx.hypothesisVerdicts.put(rejected);
		const head = await this.activeHeadIn(tx, ownerId, verdict.hypothesisId);
		if (!head) throw new HypothesisError(404, "hypothesis not found");
		return { verdict: rejected, hypothesis: head };
	}

	/** 最近一次已确认判定决定状态：挑战覆盖支持，反之亦然；unclear 不变。 */
	private applyJudgment(head: Hypothesis, judgment: HypothesisJudgment): Hypothesis {
		if (head.status === "retired") return head;
		if (judgment === "supports") return { ...head, status: "supported" };
		if (judgment === "challenges") return { ...head, status: "challenged" };
		return head;
	}

	private async resolveSubjectIn(tx: Transaction, ownerId: string, subject: HypothesisSubjectRef): Promise<void> {
		if (subject.kind === "market_event") {
			const head = await tx.marketEvents.get(subject.eventId);
			if (!head || head.ownerId !== ownerId) throw new HypothesisError(404, "event not found");
			if (!await tx.marketEventVersions.get(`${subject.eventId}:${subject.version}`))
				throw new HypothesisError(404, "event version not found");
			return;
		}
		if (subject.kind === "source_item") {
			const item = await tx.sourceItems.get(subject.sourceItemId);
			if (!item || item.status !== "active") throw new HypothesisError(404, "source item not found");
			return;
		}
		const result = await tx.comparisonResults.get(subject.comparisonResultId);
		if (!result || result.ownerId !== ownerId) throw new HypothesisError(404, "comparison result not found");
	}

	private async mutate<T>(ownerId: string, work: (tx: Transaction) => Promise<T>): Promise<T> {
		const lock = await this.storage.runExclusive(`hypotheses:${ownerId}`, () => this.storage.transaction(work));
		if (!lock.acquired) throw new HypothesisError(409, "hypothesis write in progress");
		return lock.value!;
	}

	private async commitCreate(tx: Transaction, ownerId: string, key: string, input: HypothesisCreateInput): Promise<HypothesisOperationResult> {
		if (!text(ownerId, 256) || !text(key, 256)) fail("invalid operation key");
		const task = await tx.tasks.get(input.taskId);
		if (!task || task.ownerId !== ownerId) throw new HypothesisError(404, "task not found");
		if (!await taskActiveIn(tx, task, new Date(this.now()))) throw new HypothesisError(404, "task not found");
		const taskVersion = input.taskVersion ?? task.currentVersion;
		if (!await tx.taskVersions.get(`${task.id}:${taskVersion}`)) throw new HypothesisError(404, "task version not found");

		const operationId = hash(["hypothesis", ownerId, key]);
		const digest = hash({ op: "create", input, taskVersion });
		const operation = await tx.hypothesisOperations.get(operationId);
		if (operation) {
			if (operation.digest !== digest) throw new HypothesisError(409, "idempotency conflict");
			const head = operation.resultRef.hypothesisId
				? await tx.hypotheses.get(operation.resultRef.hypothesisId) : null;
			const version = operation.resultRef.versionId
				? await tx.hypothesisVersions.get(operation.resultRef.versionId) : null;
			if (!head || !version) throw new Error("hypothesis operation result missing");
			return { status: operation.status as HypothesisOperationResult["status"], hypothesis: head, version };
		}
		// 同任务下同陈述视为同一假设：重复提交返回原结果，不同内容要求走 revise。
		const logicalKey = hash([ownerId, task.id, normalize(input.statement).toLocaleLowerCase("en-US")]);
		const hypothesisId = hash(["hypothesis", ownerId, task.id, logicalKey]);
		const existing = await tx.hypotheses.get(hypothesisId);
		if (existing) {
			const current = await this.currentVersionIn(tx, existing);
			const same = current.statement === input.statement
				&& current.rationale === input.rationale
				&& (current.testable ?? undefined) === (input.testable ?? undefined)
				&& current.origin === input.origin;
			if (!same) throw new HypothesisError(409, "statement already exists; revise the hypothesis instead");
			await tx.hypothesisOperations.put({
				id: operationId, ownerId, digest, kind: "create",
				resultRef: { hypothesisId, versionId: current.id },
				status: "duplicate", createdAt: this.now(),
			});
			return { status: "duplicate", hypothesis: existing, version: current };
		}
		const createdAt = this.now();
		const version: HypothesisVersion = {
			id: `${hypothesisId}:1`,
			hypothesisId,
			ownerId,
			version: 1,
			statement: input.statement,
			rationale: input.rationale,
			...(input.testable !== undefined ? { testable: input.testable } : {}),
			origin: input.origin,
			...(input.draftRef ? { draftRef: structuredClone(input.draftRef) } : {}),
			createdAt,
		};
		const head: Hypothesis = {
			id: hypothesisId,
			ownerId,
			taskId: task.id,
			taskVersion,
			currentVersion: 1,
			status: "open",
			createdAt,
		};
		await tx.hypothesisVersions.put(version);
		await tx.hypotheses.put(head);
		await tx.hypothesisOperations.put({
			id: operationId, ownerId, digest, kind: "create",
			resultRef: { hypothesisId, versionId: version.id },
			status: "created", createdAt,
		});
		return { status: "created", hypothesis: head, version };
	}

	private async commitRevise(
		tx: Transaction, ownerId: string, hypothesisId: string, key: string,
		expectedVersion: number, input: HypothesisReviseInput,
	): Promise<HypothesisOperationResult> {
		if (!text(ownerId, 256) || !text(key, 256)) fail("invalid operation key");
		const head = await this.activeHeadIn(tx, ownerId, hypothesisId);
		if (!head) throw new HypothesisError(404, "hypothesis not found");
		if (head.status === "retired") throw new HypothesisError(409, "hypothesis retired");
		const previous = await this.currentVersionIn(tx, head);
		const operationId = hash(["hypothesis", ownerId, key]);
		const digest = hash({ op: "revise", input, expectedVersion, hypothesisId });
		const operation = await tx.hypothesisOperations.get(operationId);
		if (operation) {
			// 幂等回放优先于版本校验：重试不会因推进后的版本号而报冲突。
			if (operation.digest !== digest) throw new HypothesisError(409, "idempotency conflict");
			const version = operation.resultRef.versionId
				? await tx.hypothesisVersions.get(operation.resultRef.versionId) : null;
			const current = operation.resultRef.hypothesisId
				? await tx.hypotheses.get(operation.resultRef.hypothesisId) : null;
			if (!version || !current) throw new Error("hypothesis operation result missing");
			return { status: operation.status as HypothesisOperationResult["status"], hypothesis: current, version };
		}
		if (head.currentVersion !== expectedVersion) throw new HypothesisError(409, "hypothesis version conflict");
		const unchanged = previous.statement === input.statement
			&& previous.rationale === input.rationale
			&& (previous.testable ?? undefined) === (input.testable ?? undefined);
		if (unchanged) {
			await tx.hypothesisOperations.put({
				id: operationId, ownerId, digest, kind: "revise",
				resultRef: { hypothesisId, versionId: previous.id },
				status: "unchanged", createdAt: this.now(),
			});
			return { status: "unchanged", hypothesis: head, version: previous };
		}
		// 修订不能与同任务其他假设的陈述重复：避免两条假设无法区分判定。
		const clashLogical = hash([ownerId, head.taskId, normalize(input.statement).toLocaleLowerCase("en-US")]);
		const clashId = hash(["hypothesis", ownerId, head.taskId, clashLogical]);
		const clash = clashId !== hypothesisId ? await tx.hypotheses.get(clashId) : null;
		if (clash) throw new HypothesisError(409, "statement already exists on another hypothesis");
		const number = head.currentVersion + 1;
		const createdAt = this.now();
		const version: HypothesisVersion = {
			id: `${hypothesisId}:${number}`,
			hypothesisId,
			ownerId,
			version: number,
			statement: input.statement,
			rationale: input.rationale,
			...(input.testable !== undefined ? { testable: input.testable } : {}),
			origin: previous.origin,
			...(previous.draftRef ? { draftRef: previous.draftRef } : {}),
			createdAt,
		};
		await tx.hypothesisVersions.put(version);
		const nextHead: Hypothesis = { ...head, currentVersion: number };
		await tx.hypotheses.put(nextHead);
		await tx.hypothesisOperations.put({
			id: operationId, ownerId, digest, kind: "revise",
			resultRef: { hypothesisId, versionId: version.id },
			status: "revised", createdAt,
		});
		return { status: "revised", hypothesis: nextHead, version };
	}

	private async commitRetire(
		tx: Transaction, ownerId: string, hypothesisId: string, key: string, expectedVersion: number,
	): Promise<HypothesisOperationResult> {
		if (!text(ownerId, 256) || !text(key, 256)) fail("invalid operation key");
		const head = await this.activeHeadIn(tx, ownerId, hypothesisId);
		if (!head) throw new HypothesisError(404, "hypothesis not found");
		const current = await this.currentVersionIn(tx, head);
		const operationId = hash(["hypothesis", ownerId, key]);
		const digest = hash({ op: "retire", expectedVersion, hypothesisId });
		const operation = await tx.hypothesisOperations.get(operationId);
		if (operation) {
			if (operation.digest !== digest) throw new HypothesisError(409, "idempotency conflict");
			return { status: operation.status as HypothesisOperationResult["status"], hypothesis: head, version: current };
		}
		if (head.currentVersion !== expectedVersion) throw new HypothesisError(409, "hypothesis version conflict");
		if (head.status === "retired") {
			await tx.hypothesisOperations.put({
				id: operationId, ownerId, digest, kind: "retire",
				resultRef: { hypothesisId }, status: "unchanged", createdAt: this.now(),
			});
			return { status: "unchanged", hypothesis: head, version: current };
		}
		const retired: Hypothesis = { ...head, status: "retired" };
		await tx.hypotheses.put(retired);
		await tx.hypothesisOperations.put({
			id: operationId, ownerId, digest, kind: "retire",
			resultRef: { hypothesisId }, status: "retired", createdAt: this.now(),
		});
		return { status: "retired", hypothesis: retired, version: current };
	}

	private async commitVerdict(
		tx: Transaction, ownerId: string, hypothesisId: string, key: string,
		input: HypothesisVerdictInput,
	): Promise<HypothesisOperationResult> {
		if (!text(ownerId, 256) || !text(key, 256)) fail("invalid operation key");
		const head = await this.activeHeadIn(tx, ownerId, hypothesisId);
		if (!head) throw new HypothesisError(404, "hypothesis not found");
		if (head.status === "retired") throw new HypothesisError(409, "hypothesis retired");
		await this.resolveSubjectIn(tx, ownerId, input.subject);

		const operationId = hash(["hypothesis", ownerId, key]);
		const digest = hash({ op: "verdict", input, hypothesisId, hypothesisVersion: head.currentVersion });
		const operation = await tx.hypothesisOperations.get(operationId);
		if (operation) {
			if (operation.digest !== digest) throw new HypothesisError(409, "idempotency conflict");
			const verdict = operation.resultRef.verdictId
				? await tx.hypothesisVerdicts.get(operation.resultRef.verdictId) : null;
			if (!verdict) throw new Error("hypothesis operation result missing");
			return { status: operation.status === "verdict_duplicate" ? "verdict_duplicate" : "verdict_recorded", verdict, hypothesis: head };
		}
		const dedupKey = hash(["verdict", ownerId, hypothesisId, head.currentVersion, subjectKey(input.subject)]);
		const existing = (await tx.hypothesisVerdicts.listByOwner(ownerId))
			.find(v => v.dedupKey === dedupKey && v.stage !== "rejected");
		if (existing) {
			// 同主体同判定内容 → 幂等重放；换判定（含覆盖已确认判定）→ 冲突，
			// 要求先驳回初判或修订假设到新版本，不静默覆盖。
			if (existing.judgment !== input.judgment || existing.explanation !== input.explanation)
				throw new HypothesisError(409, "verdict already exists for this subject; revise the hypothesis or reject the pending verdict");
			await tx.hypothesisOperations.put({
				id: operationId, ownerId, digest, kind: "verdict",
				resultRef: { hypothesisId, verdictId: existing.id },
				status: "verdict_duplicate", createdAt: this.now(),
			});
			return { status: "verdict_duplicate", verdict: existing, hypothesis: head };
		}
		const createdAt = this.now();
		const verdict: HypothesisVerdict = {
			id: hash([dedupKey, input.judgment, hash(input.explanation)]),
			dedupKey,
			ownerId,
			hypothesisId,
			hypothesisVersion: head.currentVersion,
			subject: structuredClone(input.subject),
			judgment: input.judgment,
			explanation: input.explanation,
			...(input.quote !== undefined ? { quote: input.quote } : {}),
			stage: "confirmed",
			confirmedAt: createdAt,
			createdAt,
		};
		await tx.hypothesisVerdicts.put(verdict);
		const nextHead = this.applyJudgment(head, input.judgment);
		if (nextHead !== head) {
			await tx.hypotheses.put(nextHead);
			// 状态变更即进本人订阅筛选（S5）：模拟来源与 unclear 不会入队，只留筛选记录。
			if (input.judgment !== "unclear")
				await this.selections.selectHypothesisVerdictIn(tx, verdict, nextHead);
		}
		await tx.hypothesisOperations.put({
			id: operationId, ownerId, digest, kind: "verdict",
			resultRef: { hypothesisId, verdictId: verdict.id },
			status: "verdict_recorded", createdAt,
		});
		return { status: "verdict_recorded", verdict, hypothesis: nextHead };
	}
}

/** 初判写入入口（S2 异步 job 用）：preliminary 阶段，不改状态。 */
export class HypothesisPreliminaryWriter {
	constructor(
		private readonly storage: Storage,
		private readonly now: () => string = () => new Date().toISOString(),
	) {}

	/** 幂等：同一 (假设, 证据主体) 已有未驳回判定时返回原判定，不重复写。 */
	async record(input: {
		ownerId: string;
		hypothesisId: string;
		subject: HypothesisSubjectRef;
		judgment: HypothesisJudgment;
		explanation: string;
		quote?: string;
		preliminary: { modelRef: string; generatedAt: string };
	}): Promise<{ verdict: HypothesisVerdict; outcome: "recorded" | "duplicate" }> {
		const { ownerId, hypothesisId } = input;
		if (!text(input.explanation, explanationMax)) throw new HypothesisError(400, "invalid explanation");
		if (input.quote !== undefined && !text(input.quote, quoteMax)) throw new HypothesisError(400, "invalid quote");
		if (!["supports", "challenges", "unclear"].includes(input.judgment)) throw new HypothesisError(400, "invalid judgment");
		if (!validSubject(input.subject)) throw new HypothesisError(400, "invalid subject");
		if (!text(input.preliminary.modelRef, 256) || !text(input.preliminary.generatedAt, 40))
			throw new HypothesisError(400, "preliminary mark required");
		return this.storage.transaction(async tx => {
			const head = await tx.hypotheses.get(hypothesisId);
			if (!head || head.ownerId !== ownerId) throw new HypothesisError(404, "hypothesis not found");
			if (head.status === "retired") throw new HypothesisError(409, "hypothesis retired");
			// 与读写路径同一不变量：到期/已删除任务的假设不写初判。
			const task = await tx.tasks.get(head.taskId);
			if (!task || task.ownerId !== ownerId || !(await taskActiveIn(tx, task, new Date(this.now()))))
				throw new HypothesisError(404, "task not found");
			await this.resolveSubject(tx, ownerId, input.subject);
			const dedupKey = hash(["verdict", ownerId, hypothesisId, head.currentVersion, subjectKey(input.subject)]);
			const existing = (await tx.hypothesisVerdicts.listByOwner(ownerId))
				.find(v => v.dedupKey === dedupKey && v.stage !== "rejected");
			if (existing) return { verdict: existing, outcome: "duplicate" };
			const createdAt = this.now();
			const verdict: HypothesisVerdict = {
				id: hash([dedupKey, input.judgment, hash(input.explanation), "preliminary"]),
				dedupKey,
				ownerId,
				hypothesisId,
				hypothesisVersion: head.currentVersion,
				subject: structuredClone(input.subject),
				judgment: input.judgment,
				explanation: input.explanation,
				...(input.quote !== undefined ? { quote: input.quote } : {}),
				stage: "preliminary",
				preliminary: structuredClone(input.preliminary),
				createdAt,
			};
			await tx.hypothesisVerdicts.put(verdict);
			return { verdict, outcome: "recorded" };
		});
	}

	private async resolveSubject(tx: Transaction, ownerId: string, subject: HypothesisSubjectRef): Promise<void> {
		if (subject.kind === "market_event") {
			const head = await tx.marketEvents.get(subject.eventId);
			if (!head || head.ownerId !== ownerId) throw new HypothesisError(404, "event not found");
			if (!await tx.marketEventVersions.get(`${subject.eventId}:${subject.version}`))
				throw new HypothesisError(404, "event version not found");
			return;
		}
		if (subject.kind === "source_item") {
			const item = await tx.sourceItems.get(subject.sourceItemId);
			if (!item || item.status !== "active") throw new HypothesisError(404, "source item not found");
			return;
		}
		const result = await tx.comparisonResults.get(subject.comparisonResultId);
		if (!result || result.ownerId !== ownerId) throw new HypothesisError(404, "comparison result not found");
	}
}

export type { HypothesisStatus, HypothesisVerdictStage, HypothesisOrigin };
