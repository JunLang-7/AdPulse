import type { Limits, Signal, Strategy } from "./domain/strategy.js";
import { applyChanges, validateStrategy } from "./domain/strategy.js";
import { invalidateAlertCandidate } from "./investigation-alerts.js";
import type { Actor, ChoiceCommand, Recipient } from "./ports/channel.js";
import type { PolicyEngine, Proposal } from "./ports/policyEngine.js";
import type { Storage, Transaction } from "./ports/storage.js";
import type {
	Delivery,
	Inbox,
	JobTask,
	Round,
	Session,
	TaskVersion,
} from "./state/model.js";

export interface StartSession {
	requestId: string;
	ownerId: string;
	taskRef?: { taskId: string; taskVersion: number };
	recipient: Recipient;
	allowedActorIds: string[];
	strategy: Strategy;
	limits: Limits;
	signal: Signal;
	expiresAt: string;
}

const inboxId = (command: ChoiceCommand): string =>
	JSON.stringify([command.sourceId, command.eventId]);
const canonicalJson = (value: unknown): string =>
	JSON.stringify(value, (_key, item) =>
		item && typeof item === "object" && !Array.isArray(item)
			? Object.keys(item)
					.sort()
					.reduce<Record<string, unknown>>((result, child) => {
						result[child] = item[child];
						return result;
					}, {})
			: item,
	);

const INVESTIGATION_ROUND_TTL_MS = 24 * 60 * 60 * 1000;

async function investigationRoundExpiry(
	tx: Transaction,
	session: Session,
	frozenAt: string,
): Promise<string> {
	const version = session.taskRef
		? await tx.taskVersions.get(
				`${session.taskRef.taskId}:${session.taskRef.taskVersion}`,
			)
		: null;
	const taskEndsAt = version?.observation.endsAt;
	const expiresAt = Math.min(
		Date.parse(frozenAt) + INVESTIGATION_ROUND_TTL_MS,
		taskEndsAt ? Date.parse(taskEndsAt) : Infinity,
		session.expiresAt ? Date.parse(session.expiresAt) : Infinity,
	);
	return new Date(expiresAt).toISOString();
}

/** Application service: console and IM submit the same command; no HTTP/platform SDKs. */
export class Orchestrator {
	constructor(
		private storage: Storage,
		private policy: PolicyEngine,
		private now: () => string = () => new Date().toISOString(),
		private id: () => string = () => crypto.randomUUID(),
		/** Local storage checks only; runs within the same retryable transaction. */
		private authorizePlatformActor?: (
			tx: Transaction,
			actor: Extract<Actor, { kind: "platform" }>,
		) => Promise<boolean>,
		/**
		 * 卡片上的站内详情链接。由装配层按控制台公开 origin 提供，核心不感知域名；
		 * 返回 undefined 时卡片不带链接（与未配置控制台入口时的行为一致）。
		 */
		private detailUrlFor?: (sessionId: string) => string | undefined,
	) {}

	async startSession(input: StartSession): Promise<Session> {
		validateStrategy(input.strategy, input.limits);
		if (
			!input.requestId ||
			!input.ownerId ||
			!input.recipient?.accountId ||
			!["user", "group"].includes(input.recipient.kind) ||
			!input.recipient.externalId ||
			!Array.isArray(input.allowedActorIds) ||
			input.allowedActorIds.length === 0 ||
			!input.allowedActorIds.every(
				(id) => typeof id === "string" && id.length > 0,
			) ||
			!input.signal?.id ||
			typeof input.signal.title !== "string" ||
			typeof input.signal.summary !== "string" ||
			!Array.isArray(input.signal.evidence) ||
			!Number.isFinite(Date.parse(input.expiresAt)) ||
			Date.parse(input.expiresAt) <= Date.parse(this.now())
		) {
			throw new Error("invalid session input");
		}
		return this.storage.transaction(async (tx) => {
			let taskVersion: TaskVersion | null = null;
			if (input.taskRef) {
				const task = await tx.tasks.get(input.taskRef.taskId);
				taskVersion = await tx.taskVersions.get(
					`${input.taskRef.taskId}:${input.taskRef.taskVersion}`,
				);
				if (!task || task.ownerId !== input.ownerId || !taskVersion)
					throw new Error("task not found");
				if (canonicalJson(taskVersion.strategy) !== canonicalJson(input.strategy))
					throw new Error("task strategy mismatch");
			}
			const existing = await tx.sessions.get(input.requestId);
			if (existing) {
				if (existing.ownerId !== input.ownerId)
					throw new Error("session id already in use");
				if (
					canonicalJson(existing.taskRef ?? null) !==
					canonicalJson(input.taskRef ?? null)
				)
					throw new Error("idempotency conflict");
				return existing;
			}
			const rules = taskVersion?.rules;
			const monetarySuggestionsAllowed = Boolean(
				rules?.metricDefinition &&
				rules.currency &&
				rules.unit &&
				rules.statWindowDays !== undefined &&
				rules.alertThresholdMinor !== undefined &&
				rules.minimumSpendMinor !== undefined &&
				rules.minimumConsultations !== undefined,
			);
			const session: Session = {
				id: input.requestId,
				ownerId: input.ownerId,
				deliveryMode: "channel",
				...(input.taskRef ? { taskRef: input.taskRef } : {}),
				...(input.taskRef ? { monetarySuggestionsAllowed } : {}),
				recipient: input.recipient,
				allowedActorIds: input.allowedActorIds,
				strategy: input.strategy,
				limits: input.limits,
				signal: input.signal,
				version: 0,
				roundNo: 0,
				status: "planning",
				expiresAt: new Date(input.expiresAt).toISOString(),
				createdAt: this.now(),
			};
			await tx.sessions.put(session);
			await tx.snapshots.put({
				id: `${session.id}:0`,
				sessionId: session.id,
				version: 0,
				strategy: session.strategy,
				changes: [],
				createdAt: this.now(),
			});
			await this.enqueue(tx, {
				kind: "prepare_round",
				sessionId: session.id,
				version: 0,
			});
			return session;
		});
	}

	/** Must commit before a webhook is ACKed. Event identity is scoped to a connection. */
	async receiveChoice(command: ChoiceCommand): Promise<Inbox> {
		if (!command.sourceId || !command.eventId || !command.actionRef)
			throw new Error("invalid choice command");
		const canonical = canonicalJson(command);
		return this.storage.transaction(async (tx) => {
			const key = inboxId(command);
			const existing = await tx.inbox.get(key);
			if (existing) {
				if (canonicalJson(existing.command) !== canonical)
					throw new Error("idempotency conflict");
				return existing;
			}
			const inbox: Inbox = {
				id: key,
				command,
				status: "pending",
				receivedAt: this.now(),
			};
			await tx.inbox.put(inbox);
			await this.enqueue(tx, { kind: "process_inbox", inboxId: key });
			return inbox;
		});
	}

	async processInbox(id: string): Promise<void> {
		await this.storage.transaction(async (tx) => {
			const inbox = await tx.inbox.get(id);
			if (inbox?.status !== "pending") return;
			const reject = async (reason: string): Promise<void> => {
				await tx.inbox.put({ ...inbox, status: "rejected", reason });
			};
			const action = await tx.actions.get(inbox.command.actionRef);
			if (!action) return reject("unknown_action");
			const round = await tx.rounds.get(action.roundId);
			if (!round) return reject("unknown_round");
			const session = await tx.sessions.get(round.sessionId);
			if (!session) return reject("unknown_session");
			const actor = inbox.command.actor;
			const authorized =
				actor.kind === "console"
					? actor.userId === session.ownerId
					: session.deliveryMode !== "web" &&
						session.recipient?.accountId === actor.accountId &&
						typeof actor.userId === "string" &&
						actor.userId === session.ownerId &&
						session.allowedActorIds.includes(actor.externalId);
			if (!authorized) return reject("forbidden");
			if (
				actor.kind === "platform" &&
				this.authorizePlatformActor &&
				!(await this.authorizePlatformActor(tx, actor))
			)
				return reject("forbidden");
			const now = this.now();
			if (
				(session.expiresAt && session.expiresAt <= now) ||
				(round.expiresAt && round.expiresAt <= now)
			)
				return reject("expired");
			if (
				session.status !== "awaiting_input" ||
				round.status !== "open" ||
				session.roundNo !== round.roundNo ||
				session.version !== round.strategyVersion
			)
				return reject("already_handled");
			const candidate = round.candidates.find(
				(option) => option.id === action.optionId,
			);
			if (!candidate) return reject("unknown_option");
			let investigationAlert = null;
			if (session.investigationAlertId) {
				investigationAlert = await tx.investigationAlerts.get(session.investigationAlertId);
				const task = session.taskRef
					? await tx.tasks.get(session.taskRef.taskId)
					: null;
				if (
					!investigationAlert ||
					investigationAlert.status !== "open" ||
					!session.alertEvidenceRef ||
					investigationAlert.current.evidence.evidenceId !== session.alertEvidenceRef.evidenceId ||
					investigationAlert.current.evidence.version !== session.alertEvidenceRef.version ||
					!task ||
					task.currentVersion !== session.taskRef?.taskVersion
				)
					return reject("stale_evidence_or_task_rules");
				if (!round.expiresAt) {
					// Earlier releases recorded the freeze event but left the round without an expiry.
					const frozenAt = investigationAlert.events
						.filter((event) => event.type === "candidate_created")
						.at(-1)?.at ?? session.createdAt;
					if ((await investigationRoundExpiry(tx, session, frozenAt)) <= now)
						return reject("expired");
				}
			}
			if (
				session.taskRef &&
				!session.monetarySuggestionsAllowed &&
				candidate.changes.some((change) => change.kind !== "enabled")
			)
				return reject("unconfirmed_monetary_semantics");

			// Validation is enforced here, independently of the policy/model producing the proposal.
			const next = applyChanges(
				session.strategy,
				candidate.changes,
				session.limits,
			);
			const version = session.version + 1;
			await tx.rounds.put({
				...round,
				status: "answered",
				selectedOptionId: candidate.id,
				selectedBy: actor,
				respondedAt: this.now(),
			});
			await tx.snapshots.put({
				id: `${session.id}:${version}`,
				sessionId: session.id,
				version,
				strategy: next,
				changes: candidate.changes,
				createdAt: this.now(),
			});
			await tx.sessions.put({
				...session,
				strategy: next,
				version,
				status: candidate.complete ? "completed" : "planning",
			});
			if (investigationAlert) {
				const deferred = candidate.id === "await_evidence";
				const at = this.now();
				await tx.investigationAlerts.put({
					...investigationAlert,
					status: deferred ? "awaiting_evidence" : "handled",
					statusReason: deferred ? "awaiting_new_evidence" : `choice:${candidate.id}`,
					updatedAt: at,
					events: [
						...investigationAlert.events,
						{
							type: deferred ? "deferred" : "handled",
							at,
						comparisonResultId: investigationAlert.current.comparisonResultId,
							evidence: investigationAlert.current.evidence,
							reason: candidate.id,
						},
					],
				});
			}
			if (candidate.complete) {
				if (session.deliveryMode !== "web") {
					await this.queueDelivery(
						tx,
						session,
						round,
						{
							title: "已记录决策",
							summary: `已选择：${candidate.label}。仅更新系统内方案，未执行广告平台操作。`,
							evidence: [],
							options: [],
						},
						[],
						"confirmation",
					);
				}
			} else {
				await this.enqueue(tx, {
					kind: "prepare_round",
					sessionId: session.id,
					version,
				});
			}
			await tx.inbox.put({ ...inbox, status: "processed" });
		});
	}

	async prepareRound(sessionId: string, version: number): Promise<void> {
		const snapshot = await this.storage.transaction((tx) =>
			tx.sessions.get(sessionId),
		);
		if (
			snapshot?.status !== "planning" ||
			snapshot.version !== version ||
			(!snapshot.investigationAlertId &&
				snapshot.expiresAt &&
				snapshot.expiresAt <= this.now())
		)
			return;
		// Slow model calls outside the transaction; commit only if the input version is still current.
		const proposal = snapshot.investigationAlertId
			? {
					card: {
						title: snapshot.signal.title,
						summary: snapshot.signal.summary,
						evidence: snapshot.signal.evidence,
					},
					candidates: [
						{ id: "handled", label: "确认已处理", changes: [], complete: true },
						{ id: "await_evidence", label: "待补证后再评估", changes: [], complete: true },
						{ id: "ignore", label: "忽略此提醒", changes: [], complete: true },
					],
				}
			: await this.policy.propose({
					strategy: snapshot.strategy,
					limits: snapshot.limits,
					signal: snapshot.signal,
					roundNo: snapshot.roundNo + 1,
				});
		this.validateProposal(proposal, snapshot);
		await this.storage.transaction(async (tx) => {
			const session = await tx.sessions.get(sessionId);
			const frozenAt = this.now();
			if (
				session?.status !== "planning" ||
				session.version !== version ||
				(!session.investigationAlertId &&
					session.expiresAt &&
					session.expiresAt <= frozenAt)
			)
				return;
			const roundNo = session.roundNo + 1;
			const card = {
				...proposal.card,
				options: proposal.candidates.map(({ id, label }) => ({ id, label })),
			};
			const alert = session.investigationAlertId
				? await tx.investigationAlerts.get(session.investigationAlertId)
				: null;
			let expiresAt = session.expiresAt;
			if (session.investigationAlertId) {
				if (
					!alert ||
					alert.status !== "open" ||
					!session.alertEvidenceRef ||
					alert.current.evidence.evidenceId !== session.alertEvidenceRef.evidenceId ||
					alert.current.evidence.version !== session.alertEvidenceRef.version ||
					alert.logicalRounds >= alert.maxPushRounds
				)
					return;
				expiresAt = await investigationRoundExpiry(tx, session, frozenAt);
				if (expiresAt <= frozenAt) {
					await invalidateAlertCandidate(tx, alert, "decision_deadline_elapsed", frozenAt);
					return;
				}
			}
			const round: Round = {
				id: `${session.id}:${roundNo}`,
				sessionId,
				roundNo,
				strategyVersion: version,
				status: "open",
				...(expiresAt ? { expiresAt } : {}),
				card,
				candidates: proposal.candidates,
			};
			await tx.rounds.put(round);
			const actions = [];
			for (const candidate of proposal.candidates) {
				const actionRef = this.id();
				await tx.actions.put({
					id: actionRef,
					roundId: round.id,
					optionId: candidate.id,
				});
				actions.push({ optionId: candidate.id, actionRef });
			}
			if (session.deliveryMode !== "web")
				await this.queueDelivery(tx, session, round, card, actions);
			await tx.sessions.put({ ...session, roundNo, status: "awaiting_input" });
			if (alert) {
				await tx.investigationAlerts.put({
					...alert,
					logicalRounds: alert.logicalRounds + 1,
					updatedAt: frozenAt,
					events: [...alert.events, {
						type: "candidate_created",
						at: frozenAt,
						comparisonResultId: alert.current.comparisonResultId,
						evidence: alert.current.evidence,
					}],
				});
			}
		});
	}

	private validateProposal(proposal: Proposal, session: Session): void {
		if (
			!proposal?.card?.title ||
			typeof proposal.card.summary !== "string" ||
			!Array.isArray(proposal.card.evidence) ||
			proposal.card.evidence.length > 6 ||
			!Array.isArray(proposal.candidates) ||
			proposal.candidates.length < 1 ||
			proposal.candidates.length > 3 ||
			new Set(proposal.candidates.map((c) => c.id)).size !==
				proposal.candidates.length
		) {
			throw new Error("invalid proposal");
		}
		for (const candidate of proposal.candidates) {
			if (
				session.taskRef &&
				!session.monetarySuggestionsAllowed &&
				candidate.changes?.some((change) => change.kind !== "enabled")
			)
				throw new Error("unconfirmed task rules prohibit monetary suggestions");
			if (
				!candidate.id ||
				!candidate.label ||
				!Array.isArray(candidate.changes) ||
				typeof candidate.complete !== "boolean"
			) {
				throw new Error("invalid candidate");
			}
			if (candidate.changes.length && proposal.card.evidence.length === 0)
				throw new Error("changes require evidence");
			applyChanges(session.strategy, candidate.changes, session.limits);
		}
	}

	private async queueDelivery(
		tx: Transaction,
		session: Session,
		round: Round,
		card: Delivery["card"],
		actions: Delivery["actions"],
		purpose: Delivery["purpose"] = "decision",
	): Promise<void> {
		if (!session.recipient || !round.expiresAt)
			throw new Error("channel delivery requires a recipient and expiry");
		// 直达链接只指站内对象详情，不含 token 或他人可见内容。
		const detailUrl = this.detailUrlFor?.(session.id);
		const cardWithDetail = detailUrl ? { ...card, detailUrl } : card;
		const delivery: Delivery = {
			id: this.id(),
			recipient: session.recipient,
			sessionId: session.id,
			roundId: round.id,
			purpose,
			expiresAt: round.expiresAt,
			status: "pending",
			card: cardWithDetail,
			actions,
		};
		await tx.deliveries.put(delivery);
		await this.enqueue(tx, { kind: "send_delivery", deliveryId: delivery.id });
	}

	private async enqueue(tx: Transaction, task: JobTask): Promise<void> {
		await tx.jobs.put({
			id: this.id(),
			task,
			status: "pending",
			runAt: this.now(),
			attempts: 0,
		});
	}
}
