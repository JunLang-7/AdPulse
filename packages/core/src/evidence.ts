import { createHash } from "node:crypto";
import type { Storage, Transaction } from "./ports/storage.js";
import { invalidateAlertsForEvidenceUpdate } from "./investigation-alerts.js";
import type {
	EvidenceImportRecord,
	EvidenceRef,
	EvidenceSource,
	EvidenceSourceInput,
	EvidenceValues,
	EvidenceVersion,
} from "./state/model.js";

export interface EvidenceImportInput {
	schemaVersion: 1;
	taskRef: { taskId: string; taskVersion: number };
	records: EvidenceImportRecord[];
}

export interface EvidenceRevisionInput {
	expectedEvidenceVersion: number;
	reason: string;
	record: EvidenceImportRecord;
}

export interface EvidenceImportResult extends EvidenceRef {
	status: "created" | "reused" | "revised";
}

export interface EvidenceDetail {
	current: EvidenceVersion;
	versions: EvidenceVersion[];
	sources: EvidenceSource[];
}

export class EvidenceValidationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "EvidenceValidationError";
	}
}

export class EvidenceConflictError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "EvidenceConflictError";
	}
}

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
const digest = (value: unknown): string =>
	createHash("sha256").update(canonicalJson(value)).digest("hex");
const operationId = (
	ownerId: string,
	operation: "import" | "revise",
	key: string,
) => JSON.stringify([ownerId, operation, key]);

const validBoundary = (value: string): boolean => {
	const match = value.match(
		/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3}0*)?(?:Z|[+-]\d{2}:\d{2})$/i,
	);
	if (!match) return false;
	const [, year, month, day, hour, minute, second] = match;
	const y = Number(year);
	const m = Number(month);
	const d = Number(day);
	return (
		m >= 1 &&
		m <= 12 &&
		d >= 1 &&
		d <= new Date(Date.UTC(y, m, 0)).getUTCDate() &&
		Number(hour) <= 23 &&
		Number(minute) <= 59 &&
		Number(second) <= 59 &&
		Number.isFinite(Date.parse(value))
	);
};
const validTimeZone = (value: string): boolean => {
	try {
		new Intl.DateTimeFormat("en", { timeZone: value });
		return true;
	} catch {
		return false;
	}
};

function nonEmpty(
	value: unknown,
	field: string,
	maxLength = 500,
): asserts value is string {
	if (typeof value !== "string" || !value.trim() || value.length > maxLength)
		throw new EvidenceValidationError(`invalid field: ${field}`);
}

function validateRawValues(
	values: EvidenceImportRecord["rawValues"],
	field: string,
): void {
	if (!values || typeof values !== "object" || Array.isArray(values))
		throw new EvidenceValidationError(`invalid field: ${field}`);
	for (const key of ["spend", "consultations"] as const) {
		const value = values[key];
		if (
			value !== undefined &&
			value !== null &&
			!(typeof value === "string" && value.length <= 500) &&
			!(typeof value === "number" && Number.isFinite(value))
		)
			throw new EvidenceValidationError(`invalid field: ${field}.${key}`);
	}
}

function validateValues(values: EvidenceValues): void {
	if (!values || typeof values !== "object" || Array.isArray(values))
		throw new EvidenceValidationError("invalid field: values");
	for (const key of ["spendMinor", "consultations"] as const) {
		const value = values[key];
		if (
			value !== undefined &&
			value !== null &&
			(!Number.isSafeInteger(value) || value < 0)
		)
			throw new EvidenceValidationError(`invalid field: values.${key}`);
	}
}

function validateRecord(record: EvidenceImportRecord): void {
	if (!record || typeof record !== "object")
		throw new EvidenceValidationError("invalid evidence record");
	nonEmpty(record.source?.platform, "source.platform", 100);
	nonEmpty(record.source?.accountRef, "source.accountRef", 256);
	nonEmpty(record.source?.reportRef, "source.reportRef", 256);
	if (record.source.sourceUri !== undefined) {
		try {
			const url = new URL(record.source.sourceUri);
			if (!["http:", "https:"].includes(url.protocol)) throw new Error();
		} catch {
			throw new EvidenceValidationError("invalid field: source.sourceUri");
		}
	}
	nonEmpty(record.scope?.planRef, "scope.planRef", 256);
	if (
		!Array.isArray(record.scope.campaignRefs) ||
		record.scope.campaignRefs.length > 100 ||
		!record.scope.campaignRefs.every(
			(value) =>
				typeof value === "string" &&
				value.trim().length > 0 &&
				value.length <= 256,
		) ||
		new Set(record.scope.campaignRefs).size !== record.scope.campaignRefs.length
	)
		throw new EvidenceValidationError("invalid field: scope.campaignRefs");
	const { startsAt, endsAt, timeZone, completeness } = record.period ?? {};
	if (
		typeof startsAt !== "string" ||
		typeof endsAt !== "string" ||
		!validBoundary(startsAt) ||
		!validBoundary(endsAt) ||
		Date.parse(startsAt) >= Date.parse(endsAt)
	)
		throw new EvidenceValidationError("invalid field: period");
	nonEmpty(timeZone, "period.timeZone", 100);
	if (!validTimeZone(timeZone))
		throw new EvidenceValidationError("invalid field: period.timeZone");
	if (completeness !== "complete" && completeness !== "partial")
		throw new EvidenceValidationError("invalid field: period.completeness");
	for (const key of ["spendMinor", "consultations"] as const) {
		const metric = record.metricsContract?.[key];
		nonEmpty(metric?.definition, `metricsContract.${key}.definition`);
		nonEmpty(metric?.formula, `metricsContract.${key}.formula`);
		nonEmpty(metric?.sourceField, `metricsContract.${key}.sourceField`, 256);
	}
	nonEmpty(record.currency?.code, "currency.code", 16);
	nonEmpty(record.currency?.minorUnit, "currency.minorUnit", 32);
	if (
		!Number.isSafeInteger(record.currency.minorUnitsPerMajor) ||
		record.currency.minorUnitsPerMajor <= 0
	)
		throw new EvidenceValidationError(
			"invalid field: currency.minorUnitsPerMajor",
		);
	nonEmpty(record.attribution?.model, "attribution.model", 200);
	if (
		record.attribution.windowDays !== undefined &&
		(!Number.isSafeInteger(record.attribution.windowDays) ||
			record.attribution.windowDays < 0)
	)
		throw new EvidenceValidationError("invalid field: attribution.windowDays");
	if (
		!["complete", "pending", "not_applicable", "unknown"].includes(
			record.callbackStatus,
		)
	)
		throw new EvidenceValidationError("invalid field: callbackStatus");
	validateRawValues(record.rawValues, "rawValues");
	validateValues(record.values);
}

function identityFor(
	ownerId: string,
	taskRef: { taskId: string; taskVersion: number },
	record: EvidenceImportRecord,
): string {
	return digest({
		ownerId,
		taskRef,
		platform: record.source.platform,
		accountRef: record.source.accountRef,
		scope: {
			planRef: record.scope.planRef,
			campaignRefs: [...record.scope.campaignRefs].sort(),
		},
		period: {
			startsAt: new Date(record.period.startsAt).toISOString(),
			endsAt: new Date(record.period.endsAt).toISOString(),
			timeZone: record.period.timeZone,
		},
	});
}

function contentOf(record: EvidenceImportRecord): unknown {
	return {
		scope: {
			planRef: record.scope.planRef,
			campaignRefs: [...record.scope.campaignRefs].sort(),
		},
		period: {
			startsAt: new Date(record.period.startsAt).toISOString(),
			endsAt: new Date(record.period.endsAt).toISOString(),
			timeZone: record.period.timeZone,
			completeness: record.period.completeness,
		},
		metricsContract: record.metricsContract,
		currency: record.currency,
		attribution: record.attribution,
		callbackStatus: record.callbackStatus,
		values: record.values,
	};
}

function sourceInput(record: EvidenceImportRecord): EvidenceSourceInput {
	return { source: record.source, rawValues: record.rawValues };
}

function makeVersion(
	evidenceId: string,
	ownerId: string,
	taskRef: { taskId: string; taskVersion: number },
	version: number,
	businessKey: string,
	contentDigest: string,
	record: EvidenceImportRecord,
	now: string,
	reason?: string,
): EvidenceVersion {
	return {
		id: `${evidenceId}:${version}`,
		evidenceId,
		ownerId,
		taskId: taskRef.taskId,
		taskVersion: taskRef.taskVersion,
		version,
		businessKey,
		contentDigest,
		scope: structuredClone(record.scope),
		period: structuredClone(record.period),
		metricsContract: structuredClone(record.metricsContract),
		currency: structuredClone(record.currency),
		attribution: structuredClone(record.attribution),
		callbackStatus: record.callbackStatus,
		values: structuredClone(record.values),
		createdAt: now,
		...(reason ? { reason } : {}),
	};
}

async function persistSource(
	tx: Transaction,
	ownerId: string,
	evidenceId: string,
	evidenceVersion: number,
	input: EvidenceSourceInput,
	now: string,
): Promise<void> {
	const id = `${evidenceId}:${evidenceVersion}:${digest(input.source.reportRef)}`;
	const sourceDigest = digest(input);
	const existing = await tx.evidenceSources.get(id);
	if (existing) {
		if (existing.digest !== sourceDigest)
			throw new EvidenceConflictError("source reference conflict");
		return;
	}
	const source: EvidenceSource = {
		id,
		ownerId,
		evidenceId,
		evidenceVersion,
		...structuredClone(input),
		digest: sourceDigest,
		createdAt: now,
	};
	await tx.evidenceSources.put(source);
}

/** Fixed-schema, atomic evidence import with immutable revisions and provenance. */
export class EvidenceService {
	constructor(
		private readonly storage: Storage,
		private readonly now: () => string = () => new Date().toISOString(),
	) {}

	async import(
		ownerId: string,
		key: string,
		input: EvidenceImportInput,
	): Promise<EvidenceImportResult[]> {
		this.validateImport(input);
		const requestDigest = digest(input);
		return this.storage.transaction(async (tx) => {
			const opId = operationId(ownerId, "import", key);
			const existingOperation = await tx.evidenceOperations.get(opId);
			if (existingOperation) {
				if (existingOperation.digest !== requestDigest)
					throw new EvidenceConflictError("idempotency conflict");
				return existingOperation.results;
			}
			const task = await tx.tasks.get(input.taskRef.taskId);
			const taskVersion = await tx.taskVersions.get(
				`${input.taskRef.taskId}:${input.taskRef.taskVersion}`,
			);
			if (!task || task.ownerId !== ownerId || !taskVersion)
				throw new EvidenceValidationError("task not found");
			const results: EvidenceImportResult[] = [];
			for (const record of input.records) {
				const businessKey = identityFor(ownerId, input.taskRef, record);
				const evidenceId = `ev_${businessKey}`;
				const contentDigest = digest(contentOf(record));
				let head = await tx.evidenceHeads.get(evidenceId);
				let status: EvidenceImportResult["status"] = "created";
				let version = 1;
				if (head) {
					if (head.ownerId !== ownerId)
						throw new EvidenceValidationError("task not found");
					version = head.currentVersion;
					const current = await tx.evidenceVersions.get(
						`${evidenceId}:${version}`,
					);
					if (!current) throw new Error("evidence version unavailable");
					if (current.contentDigest !== contentDigest)
						throw new EvidenceConflictError("evidence content conflict");
					status = "reused";
				} else {
					head = {
						id: evidenceId,
						ownerId,
						taskId: input.taskRef.taskId,
						taskVersion: input.taskRef.taskVersion,
						currentVersion: 1,
						createdAt: this.now(),
					};
					const evidence = makeVersion(
						evidenceId,
						ownerId,
						input.taskRef,
						1,
						businessKey,
						contentDigest,
						record,
						this.now(),
					);
					await tx.evidenceHeads.put(head);
					await tx.evidenceVersions.put(evidence);
				}
				await persistSource(
					tx,
					ownerId,
					evidenceId,
					version,
					sourceInput(record),
					this.now(),
				);
				results.push({ evidenceId, version, status });
			}
			await tx.evidenceOperations.put({
				id: opId,
				ownerId,
				operation: "import",
				key,
				digest: requestDigest,
				results,
			});
			await invalidateAlertsForEvidenceUpdate(
				tx,
				ownerId,
				results.filter((result) => result.status !== "reused"),
				this.now,
			);
			return results;
		});
	}

	async revise(
		ownerId: string,
		evidenceId: string,
		key: string,
		input: EvidenceRevisionInput,
	): Promise<EvidenceImportResult> {
		if (
			!Number.isSafeInteger(input?.expectedEvidenceVersion) ||
			input.expectedEvidenceVersion < 1
		)
			throw new EvidenceValidationError("invalid expected evidence version");
		nonEmpty(input.reason, "reason", 1000);
		validateRecord(input.record);
		const requestDigest = digest({ evidenceId, ...input });
		return this.storage.transaction(async (tx) => {
			const opId = operationId(ownerId, "revise", key);
			const existingOperation = await tx.evidenceOperations.get(opId);
			if (existingOperation) {
				if (existingOperation.digest !== requestDigest)
					throw new EvidenceConflictError("idempotency conflict");
				const result = existingOperation.results[0];
				if (!result) throw new Error("evidence operation result missing");
				return result;
			}
			const head = await tx.evidenceHeads.get(evidenceId);
			if (!head || head.ownerId !== ownerId)
				throw new EvidenceValidationError("evidence not found");
			const current = await tx.evidenceVersions.get(
				`${evidenceId}:${head.currentVersion}`,
			);
			if (!current) throw new Error("evidence version unavailable");
			if (current.version !== input.expectedEvidenceVersion)
				throw new EvidenceConflictError("evidence version conflict");
			const task = await tx.tasks.get(head.taskId);
			const taskVersion = await tx.taskVersions.get(
				`${head.taskId}:${head.taskVersion}`,
			);
			if (!task || task.ownerId !== ownerId || !taskVersion)
				throw new EvidenceValidationError("evidence not found");
			const businessKey = identityFor(
				ownerId,
				{ taskId: head.taskId, taskVersion: head.taskVersion },
				input.record,
			);
			if (businessKey !== current.businessKey)
				throw new EvidenceValidationError(
					"revision cannot change evidence identity",
				);
			const version = head.currentVersion + 1;
			const contentDigest = digest(contentOf(input.record));
			const evidence = makeVersion(
				evidenceId,
				ownerId,
				{ taskId: head.taskId, taskVersion: head.taskVersion },
				version,
				businessKey,
				contentDigest,
				input.record,
				this.now(),
				input.reason.trim(),
			);
			await tx.evidenceVersions.put(evidence);
			await tx.evidenceHeads.put({ ...head, currentVersion: version });
			await persistSource(
				tx,
				ownerId,
				evidenceId,
				version,
				sourceInput(input.record),
				this.now(),
			);
			const result: EvidenceImportResult = {
				evidenceId,
				version,
				status: "revised",
			};
			await tx.evidenceOperations.put({
				id: opId,
				ownerId,
				operation: "revise",
				key,
				digest: requestDigest,
				results: [result],
			});
			await invalidateAlertsForEvidenceUpdate(tx, ownerId, [result], this.now);
			return result;
		});
	}

	async listForTask(
		ownerId: string,
		taskId: string,
	): Promise<EvidenceVersion[]> {
		return this.storage.transaction(async (tx) => {
			const task = await tx.tasks.get(taskId);
			if (!task || task.ownerId !== ownerId)
				throw new EvidenceValidationError("task not found");
			const heads = (await tx.evidenceHeads.all()).filter(
				(head) => head.ownerId === ownerId && head.taskId === taskId,
			);
			const versions = await Promise.all(
				heads.map((head) =>
					tx.evidenceVersions.get(`${head.id}:${head.currentVersion}`),
				),
			);
			return versions
				.filter((version): version is EvidenceVersion => version !== null)
				.sort((a, b) => a.period.startsAt.localeCompare(b.period.startsAt));
		});
	}

	async get(
		ownerId: string,
		evidenceId: string,
	): Promise<EvidenceDetail | null> {
		return this.storage.transaction(async (tx) => {
			const head = await tx.evidenceHeads.get(evidenceId);
			if (!head || head.ownerId !== ownerId) return null;
			const versions = (await tx.evidenceVersions.all())
				.filter((version) => version.evidenceId === evidenceId)
				.sort((a, b) => a.version - b.version);
			const current = versions.find(
				(version) => version.version === head.currentVersion,
			);
			if (!current) throw new Error("evidence version unavailable");
			const sources = (await tx.evidenceSources.all())
				.filter((source) => source.evidenceId === evidenceId)
				.sort(
					(a, b) =>
						a.evidenceVersion - b.evidenceVersion ||
						a.source.reportRef.localeCompare(b.source.reportRef),
				);
			return { current, versions, sources };
		});
	}

	private validateImport(input: EvidenceImportInput): void {
		if (input?.schemaVersion !== 1)
			throw new EvidenceValidationError("invalid field: schemaVersion");
		if (
			!input.taskRef ||
			typeof input.taskRef.taskId !== "string" ||
			!input.taskRef.taskId.trim() ||
			!Number.isSafeInteger(input.taskRef.taskVersion) ||
			input.taskRef.taskVersion < 1
		)
			throw new EvidenceValidationError("invalid field: taskRef");
		if (
			!Array.isArray(input.records) ||
			input.records.length < 1 ||
			input.records.length > 2
		)
			throw new EvidenceValidationError(
				"records must contain one or two periods",
			);
		for (const record of input.records) validateRecord(record);
	}
}
