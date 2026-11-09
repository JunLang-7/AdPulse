import type { IncomingMessage, ServerResponse } from "node:http";
import type {
	EvidenceComparisonRequest,
	EvidenceImportInput,
	EvidenceRevisionInput,
	FollowUpResolutionRequest,
	Job,
	TaskInput,
	Transaction,
} from "@adpluse/core";
import { taskDraftBriefMaxLength, taskDraftProviderIds, taskDraftStages, type Runtime } from "@adpluse/runtime";
import { z } from "zod";
import { HttpError, json, readJson } from "../http.js";

const amount = z.number().finite().nonnegative();
const strategy = z
	.object({
		objective: z.string().max(2000),
		audience: z.array(z.string()).max(100),
		channels: z.record(
			z.string().min(1).max(128),
			z
				.object({
					budget: amount.optional(),
					bidCpc: amount.optional(),
					enabled: z.boolean().optional(),
				})
				.strict()
				.transform(({ budget, bidCpc, enabled }) => ({
					...(budget === undefined ? {} : { budget }),
					...(bidCpc === undefined ? {} : { bidCpc }),
					...(enabled === undefined ? {} : { enabled }),
				})),
		),
		sellingPoints: z.array(z.string()).max(100),
	})
	.strict();
const sessionInput = z
	.object({
		taskRef: z
			.object({
				taskId: z.string().min(1).max(128),
				taskVersion: z.number().int().min(1),
			})
			.strict()
			.optional(),
		recipient: z
			.object({
				accountId: z.string().min(1).max(128),
				kind: z.enum(["user", "group"]),
				externalId: z.string().min(1).max(256),
			})
			.strict(),
		allowedActorIds: z.array(z.string().min(1).max(256)).min(1).max(100),
		strategy,
		limits: z
			.object({
				maxBudgetChangeRatio: z.number().min(0).max(1),
				maxBidChangeRatio: z.number().min(0).max(1),
			})
			.strict(),
		signal: z
			.object({
				id: z.string().min(1).max(128),
				title: z.string().min(1).max(200),
				summary: z.string().max(10000),
				evidence: z
					.array(
						z
							.object({
								label: z.string().max(200),
								value: z.string().max(2000),
								sourceUrl: z.string().url().optional(),
							})
							.strict()
							.transform(({ label, value, sourceUrl }) => ({
								label,
								value,
								...(sourceUrl === undefined ? {} : { sourceUrl }),
							})),
					)
					.max(6),
			})
			.strict(),
		expiresAt: z.iso.datetime(),
	})
	.strict();
const taskDraftExtractionInput = z
	.object({
		brief: z.string().max(taskDraftBriefMaxLength).trim().min(1),
		stage: z.enum(taskDraftStages).optional(), provider: z.enum(taskDraftProviderIds).optional(),
	})
	.strict();
const taskInput = z
	.object({
		product: z.string().trim().min(1).max(200),
		strategy,
		observation: z
			.object({
				scope: z.string().max(1000).optional(),
				startsAt: z.iso.datetime().optional(),
				endsAt: z.iso.datetime().optional(),
			})
			.strict(),
		rules: z
			.object({
				metricDefinition: z.string().trim().min(1).max(500).optional(),
				metricKey: z.enum(["cost_per_consultation"]).optional(),
				currency: z.string().trim().min(1).max(16).optional(),
				unit: z.string().trim().min(1).max(32).optional(),
				statWindowDays: z.number().int().nonnegative().optional(),
				alertThresholdMinor: z.number().int().nonnegative().optional(),
				minimumSpendMinor: z.number().int().nonnegative().optional(),
				minimumConsultations: z.number().int().nonnegative().optional(),
				handlingDeadlineHours: z.number().int().nonnegative().optional(),
				maxPushRounds: z.number().int().min(1).optional(),
			})
			.strict(),
	})
	.strict();
const taskRevisionInput = z
	.object({ expectedTaskVersion: z.number().int().min(1), task: taskInput })
	.strict();
const nonBlank = (maxLength: number) =>
	z.string().min(1).max(maxLength).refine((value) => value.trim().length > 0);
const rawMetricValue = z.union([
	z.string().max(500),
	z.number().finite(),
	z.null(),
]);
const normalizedMetricValue = z
	.number()
	.int()
	.refine(Number.isSafeInteger)
	.nonnegative()
	.nullable();
const evidenceRecordInput = z
	.object({
		source: z
			.object({
				platform: nonBlank(100),
				accountRef: nonBlank(256),
				reportRef: nonBlank(256),
				sourceUri: z.url().optional(),
			})
			.strict(),
		scope: z
			.object({
				planRef: nonBlank(256),
				campaignRefs: z.array(nonBlank(256)).max(100),
			})
			.strict(),
		period: z
			.object({
				startsAt: z.iso.datetime({ offset: true }),
				endsAt: z.iso.datetime({ offset: true }),
				timeZone: nonBlank(100),
				completeness: z.enum(["complete", "partial"]),
			})
			.strict(),
		metricsContract: z
			.object({
				spendMinor: z
					.object({
						definition: nonBlank(500),
						formula: nonBlank(1000),
						sourceField: nonBlank(256),
					})
					.strict(),
				consultations: z
					.object({
						definition: nonBlank(500),
						formula: nonBlank(1000),
						sourceField: nonBlank(256),
					})
					.strict(),
			})
			.strict(),
		currency: z
			.object({
				code: nonBlank(16),
				minorUnit: nonBlank(32),
				minorUnitsPerMajor: z.number().int().refine(Number.isSafeInteger).positive(),
			})
			.strict(),
		attribution: z
			.object({
				model: nonBlank(200),
				windowDays: z.number().int().refine(Number.isSafeInteger).nonnegative().optional(),
			})
			.strict(),
		callbackStatus: z.enum(["complete", "pending", "not_applicable", "unknown"]),
		rawValues: z
			.object({
				spend: rawMetricValue.optional(),
				consultations: rawMetricValue.optional(),
			})
			.strict(),
		values: z
			.object({
				spendMinor: normalizedMetricValue.optional(),
				consultations: normalizedMetricValue.optional(),
			})
			.strict(),
	})
	.strict();
const evidenceImportInput = z
	.object({
		schemaVersion: z.literal(1),
		taskRef: z
			.object({ taskId: z.string().min(1).max(128), taskVersion: z.number().int().min(1) })
			.strict(),
		records: z.array(evidenceRecordInput).min(1).max(2),
	})
	.strict();
const evidenceRevisionInput = z
	.object({
		expectedEvidenceVersion: z.number().int().min(1),
		reason: z.string().trim().min(1).max(1000),
		record: evidenceRecordInput,
	})
	.strict();
const choiceInput = z
	.object({ actionRef: z.string().min(1).max(128) })
	.strict();
const evidenceRefInput = z
	.object({ evidenceId: z.string().min(1).max(128), version: z.number().int().min(1) })
	.strict();
const comparisonInput = z
	.object({ current: evidenceRefInput, baseline: evidenceRefInput.optional() })
	.strict();
const followUpResolutionInput = z
	.object({
		material: z.discriminatedUnion("kind", [
			z.object({ kind: z.literal("evidence"), evidenceId: z.string().min(1).max(128), version: z.number().int().min(1) }).strict(),
			z.object({ kind: z.literal("task_version"), taskId: z.string().min(1).max(128), version: z.number().int().min(1) }).strict(),
		]),
	})
	.strict();
const parseTaskInput = (body: unknown) => {
	try {
		return taskInput.parse(body) as unknown as TaskInput;
	} catch (error) {
		if (error instanceof z.ZodError) {
			const field = error.issues[0]?.path.join(".") || "body";
			throw new HttpError(400, `invalid field: ${field}`);
		}
		throw error;
	}
};
const requestId = (req: IncomingMessage): string =>
	z.uuid().parse(req.headers["idempotency-key"]);

async function sessionForJob(
	tx: Transaction,
	job: Job,
): Promise<string | null> {
	if (job.task.kind === "prepare_round") return job.task.sessionId;
	if (job.task.kind === "send_delivery")
		return (await tx.deliveries.get(job.task.deliveryId))?.sessionId ?? null;
	if (job.task.kind === "prepare_investigation_alert_session")
		return (await tx.investigationAlerts.get(job.task.alertId))?.sessionId ?? null;
	const inbox = await tx.inbox.get(job.task.inboxId);
	const action = inbox && (await tx.actions.get(inbox.command.actionRef));
	return action
		? ((await tx.rounds.get(action.roundId))?.sessionId ?? null)
		: null;
}

export async function handleAdmin(
	req: IncomingMessage,
	res: ServerResponse,
	runtime: Runtime,
	userId: string,
	path: string,
): Promise<void> {
	if (path === "/api/task-drafts/models") {
		res.setHeader("Cache-Control", "no-store");
		const models = runtime.taskDraftModels;
		if (req.method === "GET") return json(res, 200, models?.list(userId) ?? { defaultProvider: null, canConnect: false, models: [] });
		if (req.method === "PUT" || req.method === "DELETE") {
			if (!models?.list(userId).canConnect) throw new HttpError(403, "model connections disabled");
			const provider = z.enum(taskDraftProviderIds);
			if (req.method === "DELETE") {
				const choice = provider.parse(new URL(req.url ?? "", "http://localhost").searchParams.get("provider"));
				if (!models.disconnect(userId, choice)) throw new HttpError(409, "model connection busy");
			} else {
				const input = z.object({ provider, apiKey: z.string().trim().min(8).max(512) }).strict().parse(await readJson(req));
				if (!await models.connect(userId, input.provider, input.apiKey)) throw new HttpError(503, "model connection unavailable");
			}
			return json(res, 200, models.list(userId));
		}
	}
	if (path === "/api/task-drafts/extract" && req.method === "POST") {
		const { brief, stage, provider } = taskDraftExtractionInput.parse(await readJson(req));
		const suggestions = runtime.taskDraftModels
			? await runtime.taskDraftModels.extract(userId, provider, brief, stage)
			: await runtime.extractTaskDraft?.(brief, stage);
		if (!suggestions) throw new HttpError(503, "task draft extraction unavailable");
		return json(res, 200, suggestions);
	}
	if (path === "/api/tasks" && req.method === "GET") {
		return json(res, 200, { items: await runtime.tasks.list(userId) });
	}
	if (path === "/api/tasks" && req.method === "POST") {
		const input = parseTaskInput(await readJson(req));
		const task = await runtime.tasks.create(userId, requestId(req), input);
		return json(res, 201, task);
	}
	if (path === "/api/evidence/imports" && req.method === "POST") {
		let input: EvidenceImportInput;
		try {
			input = evidenceImportInput.parse(await readJson(req)) as EvidenceImportInput;
		} catch (error) {
			if (error instanceof z.ZodError) {
				const field = error.issues[0]?.path.join(".") || "body";
				throw new HttpError(400, `invalid field: ${field}`);
			}
			throw error;
		}
		const items = await runtime.evidence.import(userId, requestId(req), input);
		return json(res, items.some((item) => item.status === "created") ? 201 : 200, { items });
	}
	if (path === "/api/comparisons/evaluate" && req.method === "POST") {
		let input: EvidenceComparisonRequest;
		try {
			input = comparisonInput.parse(await readJson(req)) as EvidenceComparisonRequest;
		} catch (error) {
			if (error instanceof z.ZodError) {
				const field = error.issues[0]?.path.join(".") || "body";
				throw new HttpError(400, `invalid field: ${field}`);
			}
			throw error;
		}
		const result = await runtime.comparisons.evaluate(userId, requestId(req), input);
		await runtime.investigationAlerts.evaluateComparison(userId, result.id);
		return json(res, 201, result);
	}
	const taskComparisons = path.match(/^\/api\/tasks\/([^/]+)\/comparisons$/);
	if (taskComparisons?.[1] && req.method === "GET") {
		return json(res, 200, {
			items: await runtime.comparisons.listResultsForTask(
				userId,
				decodeURIComponent(taskComparisons[1]),
			),
		});
	}
	const taskInvestigationAlerts = path.match(
		/^\/api\/tasks\/([^/]+)\/investigation-alerts$/,
	);
	if (taskInvestigationAlerts?.[1] && req.method === "GET") {
		return json(res, 200, {
			items: await runtime.investigationAlerts.listForTask(
				userId,
				decodeURIComponent(taskInvestigationAlerts[1]),
			),
		});
	}
	const taskComparisonFollowUps = path.match(
		/^\/api\/tasks\/([^/]+)\/comparison-follow-ups$/,
	);
	if (taskComparisonFollowUps?.[1] && req.method === "GET") {
		return json(res, 200, {
			items: await runtime.comparisons.listFollowUpsForTask(
				userId,
				decodeURIComponent(taskComparisonFollowUps[1]),
			),
		});
	}
	const followUpResolution = path.match(
		/^\/api\/comparison-follow-ups\/([^/]+)\/resolve$/,
	);
	if (followUpResolution?.[1] && req.method === "POST") {
		let input: FollowUpResolutionRequest;
		try {
			input = followUpResolutionInput.parse(await readJson(req)) as FollowUpResolutionRequest;
		} catch (error) {
			if (error instanceof z.ZodError) {
				const field = error.issues[0]?.path.join(".") || "body";
				throw new HttpError(400, `invalid field: ${field}`);
			}
			throw error;
		}
		const result = await runtime.comparisons.resolveFollowUp(
			userId,
			decodeURIComponent(followUpResolution[1]),
			requestId(req),
			input,
		);
		return json(res, 200, result);
	}
	const taskEvidence = path.match(/^\/api\/tasks\/([^/]+)\/evidence$/);
	if (taskEvidence?.[1] && req.method === "GET") {
		const taskId = decodeURIComponent(taskEvidence[1]);
		return json(res, 200, { items: await runtime.evidence.listForTask(userId, taskId) });
	}
	const evidenceRevision = path.match(/^\/api\/evidence\/([^/]+)\/revisions$/);
	if (evidenceRevision?.[1] && req.method === "POST") {
		let input: EvidenceRevisionInput;
		try {
			input = evidenceRevisionInput.parse(await readJson(req)) as EvidenceRevisionInput;
		} catch (error) {
			if (error instanceof z.ZodError) {
				const field = error.issues[0]?.path.join(".") || "body";
				throw new HttpError(400, `invalid field: ${field}`);
			}
			throw error;
		}
		const result = await runtime.evidence.revise(
			userId,
			decodeURIComponent(evidenceRevision[1]),
			requestId(req),
			input,
		);
		return json(res, 201, result);
	}
	const evidenceDetail = path.match(/^\/api\/evidence\/([^/]+)$/);
	if (evidenceDetail?.[1] && req.method === "GET") {
		const detail = await runtime.evidence.get(userId, decodeURIComponent(evidenceDetail[1]));
		if (!detail) throw new HttpError(404, "evidence not found");
		return json(res, 200, detail);
	}
	if (path.startsWith("/api/tasks/") && req.method === "GET") {
		const id = decodeURIComponent(path.slice("/api/tasks/".length));
		const result = await runtime.storage.transaction(async (tx) => {
			const task = await tx.tasks.get(id);
			if (!task || task.ownerId !== userId)
				throw new HttpError(404, "task not found");
			const versions = (await tx.taskVersions.all())
				.filter((version) => version.taskId === id)
				.sort((a, b) => a.version - b.version);
			const current = versions.find(
				(version) => version.version === task.currentVersion,
			);
			if (!current) throw new HttpError(503, "task version unavailable");
			return { task: current, versions };
		});
		return json(res, 200, result);
	}
	if (path.startsWith("/api/tasks/") && req.method === "PATCH") {
		const id = decodeURIComponent(path.slice("/api/tasks/".length));
		let parsed: z.infer<typeof taskRevisionInput>;
		try {
			parsed = taskRevisionInput.parse(await readJson(req));
		} catch (error) {
			if (error instanceof z.ZodError) {
				const field = error.issues[0]?.path.join(".") || "body";
				throw new HttpError(400, `invalid field: ${field}`);
			}
			throw error;
		}
		const task = await runtime.tasks.revise(
			userId,
			id,
			parsed.expectedTaskVersion,
			requestId(req),
			parsed.task as unknown as TaskInput,
		);
		return json(res, 200, task);
	}
	if (path === "/api/sessions" && req.method === "POST") {
		const input = sessionInput.parse(await readJson(req));
		if (!runtime.channels.has(input.recipient.accountId))
			throw new HttpError(400, "unknown recipient account");
		if (Date.parse(input.expiresAt) <= Date.now())
			throw new HttpError(400, "expiry must be in the future");
		const { taskRef, ...sessionFields } = input;
		const session = await runtime.decisions.startSession({
			...sessionFields,
			...(taskRef ? { taskRef } : {}),
			requestId: requestId(req),
			ownerId: userId,
		});
		return json(res, 201, session);
	}
	if (path === "/api/sessions" && req.method === "GET") {
		const items = await runtime.storage.transaction(async (tx) =>
			(await tx.sessions.all()).filter((s) => s.ownerId === userId),
		);
		return json(res, 200, { items });
	}
	if (path.startsWith("/api/sessions/") && req.method === "GET") {
		const id = decodeURIComponent(path.slice("/api/sessions/".length));
		const detail = await runtime.storage.transaction(async (tx) => {
			const session = await tx.sessions.get(id);
			if (!session || session.ownerId !== userId)
				throw new HttpError(404, "session not found");
			const rounds = (await tx.rounds.all())
				.filter((r) => r.sessionId === id)
				.sort((a, b) => a.roundNo - b.roundNo);
			const roundIds = new Set(rounds.map((r) => r.id));
			const actions = (await tx.actions.all()).filter((a) =>
				roundIds.has(a.roundId),
			);
			const actionIds = new Set(actions.map((a) => a.id));
			const inbox = (await tx.inbox.all()).filter((i) =>
				actionIds.has(i.command.actionRef),
			);
			const inboxIds = new Set(inbox.map((i) => i.id));
			const deliveries = (await tx.deliveries.all()).filter(
				(d) => d.sessionId === id,
			);
			const deliveryIds = new Set(deliveries.map((d) => d.id));
			const jobs = (await tx.jobs.all()).filter((j) =>
				j.task.kind === "prepare_round"
					? j.task.sessionId === id
					: j.task.kind === "process_inbox"
						? inboxIds.has(j.task.inboxId)
						: j.task.kind === "send_delivery"
							? deliveryIds.has(j.task.deliveryId)
							: j.task.alertId === session.investigationAlertId,
			);
			return {
				session,
				rounds,
				actions,
				inbox,
				deliveries,
				jobs,
				snapshots: (await tx.snapshots.all())
					.filter((s) => s.sessionId === id)
					.sort((a, b) => a.version - b.version),
			};
		});
		return json(res, 200, detail);
	}
	if (path === "/api/choices" && req.method === "POST") {
		const input = choiceInput.parse(await readJson(req));
		const inbox = await runtime.decisions.receiveChoice({
			sourceId: `console:${userId}`,
			eventId: requestId(req),
			actionRef: input.actionRef,
			actor: { kind: "console", userId },
		});
		return json(res, 202, { inboxId: inbox.id, status: inbox.status });
	}
	if (path.startsWith("/api/choices/") && req.method === "GET") {
		const id = decodeURIComponent(path.slice("/api/choices/".length));
		const inbox = await runtime.storage.transaction((tx) => tx.inbox.get(id));
		if (
			inbox?.command.actor.kind !== "console" ||
			inbox.command.actor.userId !== userId
		) {
			throw new HttpError(404, "choice not found");
		}
		return json(res, 200, inbox);
	}
	const retry = path.match(/^\/api\/jobs\/([^/]+)\/retry$/);
	if (retry?.[1] && req.method === "POST") {
		const id = decodeURIComponent(retry[1]);
		await runtime.storage.transaction(async (tx) => {
			const job = await tx.jobs.get(id);
			const sessionId = job && (await sessionForJob(tx, job));
			const session = sessionId && (await tx.sessions.get(sessionId));
			if (!job || !session || session.ownerId !== userId)
				throw new HttpError(404, "job not found");
			if (job.status !== "failed")
				throw new HttpError(409, "only failed jobs may be retried");
			await tx.jobs.put({
				...job,
				attempts: 0,
				status: "pending",
				runAt: new Date().toISOString(),
			});
			if (job.task.kind === "send_delivery") {
				const delivery = await tx.deliveries.get(job.task.deliveryId);
				if (delivery && delivery.status !== "sent")
					await tx.deliveries.put({ ...delivery, status: "pending" });
			}
		});
		return json(res, 200, { ok: true });
	}
	throw new HttpError(404, "route not found");
}
