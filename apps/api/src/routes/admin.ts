import type { IncomingMessage, ServerResponse } from "node:http";
import type {
	AuthenticationService,
	EvidenceComparisonRequest,
	EvidenceImportInput,
	EvidenceRevisionInput,
	FollowUpResolutionRequest,
	Job,
	TaskInput,
	Transaction,
} from "@adpluse/core";
import { ModelConnectionError, modelConnectionProtocols, normalizeModelBaseUrl, validateModelConnectionInput, type ModelConnectionInput, type ModelConnectionProtocol } from "@adpluse/core";
import { findCatalogModel, taskDraftBriefMaxLength, taskDraftStages, type Runtime, type TaskDraftSelection } from "@adpluse/runtime";
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
const taskDraftSelection = z
	.object({
		provider: z.string().trim().min(1).max(64),
		model: z.string().trim().min(1).max(160),
	})
	.strict();
const taskDraftConnectionInput = z
	.object({
		provider: z.string().trim().min(1).max(64),
		model: z.string().trim().min(1).max(160),
		apiKey: z.string().trim().min(8).max(512),
	})
	.strict();
const taskDraftExtractionInput = z
	.object({
		brief: z.string().max(taskDraftBriefMaxLength).trim().min(1),
		stage: z.enum(taskDraftStages).optional(),
		provider: z.string().trim().min(1).max(64).optional(),
		model: z.string().trim().min(1).max(160).optional(),
		connectionId: z.string().trim().min(1).max(64).optional(),
	})
	.strict()
	.refine(({ provider, model, connectionId }) => {
		if (connectionId !== undefined && provider !== undefined) return false;
		return model === undefined || provider !== undefined || connectionId !== undefined;
	}, { message: "invalid model selection" });
/** Catalog membership is checked before any credential is stored or used. */
function supportedSelection(input: TaskDraftSelection): TaskDraftSelection {
	if (!findCatalogModel(input.provider, input.model)) throw new HttpError(400, "unsupported model selection");
	return input;
}
const modelConnectionInput = z
	.object({
		providerId: z.string().trim().min(1).max(48),
		kind: z.enum(["catalog", "custom"]),
		catalogId: z.string().trim().min(1).max(64).optional(),
		displayName: z.string().trim().min(1).max(80).optional(),
		baseUrl: z.string().trim().min(1).max(512),
		protocol: z.enum(modelConnectionProtocols as unknown as [string, ...string[]]),
		models: z
			.array(
				z
					.object({
						id: z.string().trim().min(1).max(160),
						label: z.string().trim().min(1).max(160).optional(),
					})
					.strict(),
			)
			.min(1)
			.max(50),
		apiKey: z.string().trim().min(8).max(512),
	})
	.strict();
const modelConnectionUpdate = z
	.object({
		expectedVersion: z.number().int().min(1),
		displayName: z.string().trim().min(1).max(80).optional(),
		models: z
			.array(
				z
					.object({
						id: z.string().trim().min(1).max(160),
						label: z.string().trim().min(1).max(160).optional(),
					})
					.strict(),
			)
			.min(1)
			.max(50)
			.optional(),
		status: z.enum(["active", "disabled"]).optional(),
		baseUrl: z.string().trim().min(1).max(512).optional(),
		protocol: z.enum(modelConnectionProtocols as unknown as [string, ...string[]]).optional(),
		credential: z
			.discriminatedUnion("action", [
				z.object({ action: z.literal("keep") }).strict(),
				z.object({ action: z.literal("replace"), apiKey: z.string().trim().min(8).max(512) }).strict(),
				z.object({ action: z.literal("remove") }).strict(),
			])
			.optional(),
	})
	.strict();
const modelPreferenceInput = z
	.object({
		expectedVersion: z.number().int().min(0),
		connectionId: z.string().trim().min(1).max(64).nullable().optional(),
		modelId: z.string().trim().min(1).max(160).nullable().optional(),
	})
	.strict();

function modelConnectionErrorStatus(reason: ModelConnectionError["reason"]): number {
	switch (reason) {
		case "connection_not_found":
			return 404;
		case "connection_conflict":
		case "credential_missing":
			return 409;
		case "credential_unreadable":
			return 503;
		case "invalid_connection":
			return 400;
	}
}

async function withModelConnectionErrors<T>(work: () => Promise<T>): Promise<T> {
	try {
		return await work();
	} catch (error) {
		if (error instanceof ModelConnectionError)
			throw new HttpError(modelConnectionErrorStatus(error.reason), error.reason);
		throw error;
	}
}
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
	if (
		job.task.kind === "send_delivery" ||
		job.task.kind === "send_investigation_decision"
	)
		return (await tx.deliveries.get(job.task.deliveryId))?.sessionId ?? null;
	if (job.task.kind === "prepare_investigation_alert_session")
		return (await tx.investigationAlerts.get(job.task.alertId))?.sessionId ?? null;
	// 日汇总投递与批次绑定，不属于任何会话。
	if (job.task.kind === "send_digest") return null;
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
	auth: AuthenticationService,
): Promise<void> {
	if (path.startsWith("/api/me/model-connections") || path === "/api/me/model-preferences") {
		res.setHeader("Cache-Control", "no-store");
		const modelApi = runtime.modelConnections;
		if (!modelApi) throw new HttpError(503, "model connections unavailable");
		if (path === "/api/me/model-connections" && req.method === "GET")
			return json(res, 200, await modelApi.service.view(userId));
		if (path === "/api/me/model-connections/test" && req.method === "POST") {
			const parsed = modelConnectionInput.parse(await readJson(req));
			const input = await withModelConnectionErrors(async () =>
				validateModelConnectionInput(parsed as ModelConnectionInput));
			if (!modelApi.protocolWired(input.protocol))
				throw new HttpError(422, "protocol not wired");
			const ok = await modelApi.probe({
				providerId: input.providerId,
				kind: input.kind,
				...(input.catalogId ? { catalogId: input.catalogId } : {}),
				baseUrl: input.baseUrl,
				protocol: input.protocol,
				modelId: input.models[0]?.id ?? "",
				apiKey: input.apiKey,
			});
			return json(res, 200, { ok });
		}
		if (path === "/api/me/model-connections" && req.method === "POST") {
			const parsed = modelConnectionInput.parse(await readJson(req));
			const input = await withModelConnectionErrors(async () =>
				validateModelConnectionInput(parsed as ModelConnectionInput));
			if (!modelApi.protocolWired(input.protocol))
				throw new HttpError(422, "protocol not wired");
			const ok = await modelApi.probe({
				providerId: input.providerId,
				kind: input.kind,
				...(input.catalogId ? { catalogId: input.catalogId } : {}),
				baseUrl: input.baseUrl,
				protocol: input.protocol,
				modelId: input.models[0]?.id ?? "",
				apiKey: input.apiKey,
			});
			// 未通过测试就不写库：不留下半个可用连接。
			if (!ok) throw new HttpError(503, "model connection unavailable");
			const created = await withModelConnectionErrors(() =>
				modelApi.service.create(userId, input, { verified: true }));
			return json(res, 201, created);
		}
		const connectionPath = /^\/api\/me\/model-connections\/([0-9a-f-]{36})(\/credential)?$/.exec(path);
		if (connectionPath?.[1]) {
			const connectionId = connectionPath[1];
			if (req.method === "DELETE") {
				const query = new URL(req.url ?? "", "http://localhost").searchParams;
				const expectedVersion = z.coerce.number().int().min(1).parse(query.get("expectedVersion"));
				if (connectionPath[2]) {
					const view = await withModelConnectionErrors(() =>
						modelApi.service.removeCredential(userId, connectionId, expectedVersion));
					return json(res, 200, view);
				}
				const view = await withModelConnectionErrors(() =>
					modelApi.service.delete(userId, connectionId, expectedVersion));
				return json(res, 200, view);
			}
			if (!connectionPath[2] && req.method === "PUT") {
				const body = modelConnectionUpdate.parse(await readJson(req));
				const view = await modelApi.service.view(userId);
				const existing = view.connections.find((item) => item.id === connectionId);
				if (!existing) throw new HttpError(404, "connection_not_found");
				if (body.expectedVersion !== existing.version) throw new HttpError(409, "connection_conflict");
				const protocol = (body.protocol ?? existing.protocol) as ModelConnectionProtocol;
				if (!modelApi.protocolWired(protocol)) throw new HttpError(422, "protocol not wired");
				const baseUrl = body.baseUrl === undefined
					? existing.baseUrl
					: await withModelConnectionErrors(async () => normalizeModelBaseUrl(body.baseUrl));
				const targetChanged = baseUrl !== existing.baseUrl || protocol !== existing.protocol;
				const replace = body.credential?.action === "replace";
				// 换目标地址/协议必须同时换密钥；不允许拿旧密钥探新主机。
				if (targetChanged && !replace)
					throw new HttpError(400, "changing the target requires a new API key");
				if (replace) {
					const models = body.models ?? existing.models;
					const ok = await modelApi.probe({
						providerId: existing.providerId,
						kind: existing.kind,
						...(existing.catalogId ? { catalogId: existing.catalogId } : {}),
						baseUrl,
						protocol,
						modelId: models[0]?.id ?? "",
						apiKey: body.credential?.action === "replace" ? body.credential.apiKey : "",
					});
					if (!ok) throw new HttpError(503, "model connection unavailable");
				}
				const updated = await withModelConnectionErrors(() =>
					modelApi.service.update(userId, connectionId, {
						expectedVersion: body.expectedVersion,
						...(body.displayName === undefined ? {} : { displayName: body.displayName }),
						...(body.models === undefined ? {} : { models: body.models }),
						...(body.status === undefined ? {} : { status: body.status }),
						...(body.baseUrl === undefined ? {} : { baseUrl: body.baseUrl }),
						...(body.protocol === undefined ? {} : { protocol: body.protocol }),
						...(body.credential === undefined ? {} : { credential: body.credential }),
					}, { verified: replace }));
				return json(res, 200, updated);
			}
		}
		if (path === "/api/me/model-preferences" && req.method === "PUT") {
			const body = modelPreferenceInput.parse(await readJson(req));
			const preference = await withModelConnectionErrors(() =>
				modelApi.service.setPreference(userId, {
					expectedVersion: body.expectedVersion,
					...(body.connectionId === undefined ? {} : { connectionId: body.connectionId }),
					...(body.modelId === undefined ? {} : { modelId: body.modelId }),
				}));
			return json(res, 200, preference);
		}
	}
	if (path === "/api/task-drafts/models") {
		res.setHeader("Cache-Control", "no-store");
		const models = runtime.taskDraftModels;
		if (req.method === "GET") return json(res, 200, models?.list(userId) ?? { canConnect: false, defaultSelection: null, providers: [], shared: [], connections: [] });
		if (req.method === "PUT" || req.method === "DELETE") {
			if (!models?.list(userId).canConnect) throw new HttpError(403, "model connections disabled");
			if (req.method === "DELETE") {
				const query = new URL(req.url ?? "", "http://localhost").searchParams;
				const selection = supportedSelection(taskDraftSelection.parse({
					provider: query.get("provider"),
					model: query.get("model"),
				}));
				if (!models.disconnect(userId, selection)) throw new HttpError(409, "model connection busy");
			} else {
				const input = taskDraftConnectionInput.parse(await readJson(req));
				const selection = supportedSelection(input);
				if (!await models.connect(userId, selection, input.apiKey)) throw new HttpError(503, "model connection unavailable");
			}
			return json(res, 200, models.list(userId));
		}
	}
	if (path === "/api/task-drafts/models/test" && req.method === "POST") {
		res.setHeader("Cache-Control", "no-store");
		const models = runtime.taskDraftModels;
		if (!models?.list(userId).canConnect) throw new HttpError(403, "model connections disabled");
		const input = taskDraftConnectionInput.parse(await readJson(req));
		const selection = supportedSelection(input);
		return json(res, 200, { ok: await models.test(selection, input.apiKey) });
	}
	if (path === "/api/task-drafts/extract" && req.method === "POST") {
		const { brief, stage, provider, model, connectionId } = taskDraftExtractionInput.parse(await readJson(req));
		const modelApi = runtime.modelConnections;
		let personal = connectionId === undefined ? undefined : { connectionId, modelId: model };
		if (!personal && modelApi && model === undefined) {
			const { preference, connections } = await modelApi.service.view(userId);
			const matching = provider === undefined ? undefined : connections.find((item) =>
				item.providerId === provider && item.status === "active" && item.hasCredential && item.models.length === 1);
			if (provider === undefined && preference.connectionId !== null && preference.modelId !== null) {
				personal = { connectionId: preference.connectionId, modelId: preference.modelId };
			} else if (matching) {
				personal = { connectionId: matching.id, modelId: matching.models[0]?.id };
			}
		}
		if (personal) {
			if (!modelApi) throw new HttpError(503, "model connections unavailable");
			const resolved = await withModelConnectionErrors(() =>
				modelApi.service.resolveCredential(userId, personal.connectionId, personal.modelId));
			const extract = modelApi.draftExtractor({
				providerId: resolved.connection.providerId,
				kind: resolved.connection.kind,
				...(resolved.connection.catalogId ? { catalogId: resolved.connection.catalogId } : {}),
				baseUrl: resolved.baseUrl,
				protocol: resolved.protocol,
				modelId: resolved.modelId,
				apiKey: resolved.apiKey,
			});
			const suggestions = extract ? await extract(brief, stage) : null;
			if (!suggestions) throw new HttpError(503, "task draft extraction unavailable");
			const current = await modelApi.service.view(userId);
			if (!current.connections.some((item) => item.id === resolved.connection.id &&
				item.version === resolved.connection.version && item.status === "active" && item.hasCredential))
				throw new HttpError(409, "connection_conflict");
			return json(res, 200, suggestions);
		}
		const models = runtime.taskDraftModels;
		if (provider !== undefined && model === undefined) {
			const suggestions = await models?.extractLegacy(userId, provider, brief, stage);
			if (!suggestions) throw new HttpError(409, "model_selection_required");
			return json(res, 200, suggestions);
		}
		if (modelApi && provider === undefined) throw new HttpError(409, "model_selection_required");
		const selection = provider === undefined || model === undefined ? undefined : { provider, model };
		if (selection && models) {
			const shared = models.extractShared(selection, brief, stage);
			if (shared) {
				const suggestions = await shared;
				if (!suggestions) throw new HttpError(503, "task draft extraction unavailable");
				return json(res, 200, suggestions);
			}
		}
		if (selection) supportedSelection(selection);
		const suggestions = runtime.taskDraftModels
			? await runtime.taskDraftModels.extract(userId, selection, brief, stage)
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
		const scope = runtime.channels.identityScopeOf(input.recipient.accountId);
		if (scope) {
			if (input.recipient.kind !== "user")
				throw new HttpError(400, "personal sessions require a user recipient");
			const identities = (await auth.listIdentities(userId)).filter(
				(identity) =>
					identity.platform === scope.platform &&
					identity.applicationId === scope.applicationId &&
					identity.tenantId === scope.tenantId,
			);
			const own = new Set(identities.map((identity) => identity.externalId));
			if (own.size === 0)
				throw new HttpError(400, "verified identity required for this account");
			if (!input.allowedActorIds.every((id) => own.has(id)))
				throw new HttpError(400, "allowed actors must be the current user");
			if (input.recipient.kind === "user" && !own.has(input.recipient.externalId))
				throw new HttpError(400, "recipient must be the current user");
		}
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
						: j.task.kind === "send_delivery" || j.task.kind === "send_investigation_decision"
							? deliveryIds.has(j.task.deliveryId)
							: j.task.kind === "send_digest"
								? false
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
			if (job.task.kind === "send_investigation_decision") {
				const delivery = await tx.deliveries.get(job.task.deliveryId);
				if (!delivery?.proactiveDecision || delivery.status !== "failed")
					throw new HttpError(409, "terminal proactive delivery cannot be retried");
			}
			await tx.jobs.put({
				...job,
				attempts: 0,
				status: "pending",
				runAt: new Date().toISOString(),
			});
			if (
				job.task.kind === "send_delivery" ||
				job.task.kind === "send_investigation_decision"
			) {
				const delivery = await tx.deliveries.get(job.task.deliveryId);
				if (delivery && delivery.status !== "sent")
					await tx.deliveries.put({ ...delivery, status: "pending" });
			}
		});
		return json(res, 200, { ok: true });
	}
	throw new HttpError(404, "route not found");
}
