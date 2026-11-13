// 个人模型连接的持久化基础（#86 PR1）：只处理元数据、版本、归属与加密凭据。
// 这里不做网络调用，也不认识 HTTP、供应商 SDK 或数据库驱动。
// 密钥只以密文落库；没有可用主密钥时调用方根本构造不出本服务（失败关闭）。

import crypto from "node:crypto";
import type { Storage, Transaction } from "./ports/storage.js";
import type {
	ModelConnectionModel,
	ModelConnectionProtocol,
	UserModelConnection,
	UserModelCredential,
	UserModelPreference,
	UserModelRevocation,
} from "./state/model.js";

export const modelConnectionProtocols: readonly ModelConnectionProtocol[] = [
	"openai-completions",
	"openai-responses",
	"anthropic-messages",
	"google-generative-ai",
];

const providerIdPattern = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
/** 用户可自定 Provider ID，必须拒绝会污染原型链或误导审计的名字。 */
const reservedProviderIds = new Set([
	"__proto__",
	"prototype",
	"constructor",
	"toString",
	"valueOf",
]);
const controlCharacters = /[\u0000-\u001f\u007f]/u;

export interface ModelCiphertext {
	keyId: string;
	algorithm: "aes-256-gcm";
	/** base64，每次加密重新随机。 */
	nonce: string;
	ciphertext: string;
	authTag: string;
}

/**
 * 凭据加密端口。实现必须在解密失败、keyId 未知或 AAD 不匹配时返回 null：
 * 调用方据此失败关闭，不允许回退到明文或他人的密钥。
 */
export interface ModelCredentialCipher {
	readonly activeKeyId: string;
	encrypt(input: { plaintext: string; aad: string }): ModelCiphertext;
	decrypt(input: { ciphertext: ModelCiphertext; aad: string }): string | null;
}

export type ModelConnectionErrorReason =
	| "invalid_connection"
	| "connection_not_found"
	| "connection_conflict"
	| "credential_missing"
	| "credential_unreadable";

export class ModelConnectionError extends Error {
	constructor(
		readonly reason: ModelConnectionErrorReason,
		message: string,
	) {
		super(message);
		this.name = "ModelConnectionError";
	}
}

/** 恢复备份后的重放报告；不包含密钥或密文。 */
export interface RevocationReplayReport {
	/** 已记录但凭据版本更新的条目：不执行，避免误删轮换后的新密钥。 */
	skipped: number;
	/** 需要停用（或已停用）的连接数。 */
	disabled: number;
	/** 连接/密文已不存在，只补记墓碑。 */
	tombstoned: number;
}

/** 对外投影：永远不含明文密钥、密文或可回读的凭据引用。 */
export interface ModelConnectionView {
	id: string;
	providerId: string;
	kind: UserModelConnection["kind"];
	catalogId?: string;
	displayName: string;
	baseUrl: string;
	protocol: ModelConnectionProtocol;
	models: ModelConnectionModel[];
	status: UserModelConnection["status"];
	version: number;
	createdAt: string;
	updatedAt: string;
	hasCredential: boolean;
	verifiedAt?: string;
	verifiedVersion?: number;
}

export interface ModelPreferenceView {
	connectionId: string | null;
	modelId: string | null;
	version: number;
}

export interface ModelConnectionsView {
	connections: ModelConnectionView[];
	preference: ModelPreferenceView;
}

export interface ModelConnectionInput {
	providerId: string;
	kind: UserModelConnection["kind"];
	catalogId?: string;
	displayName?: string;
	baseUrl: string;
	protocol: ModelConnectionProtocol;
	models: ModelConnectionModel[];
	apiKey: string;
}

/**
 * 纯校验：不读库、不联网。HTTP 层在「测试并保存」的测试请求之前先用它，
 * 避免把非法目标地址交给传输层后再报一个含糊的失败。
 */
export function validateModelConnectionInput(input: ModelConnectionInput): ModelConnectionInput {
	const providerId = validateProviderId(input.providerId);
	const kind = validateKind(input.kind);
	const baseUrl = normalizeModelBaseUrl(input.baseUrl);
	const protocol = validateProtocol(input.protocol);
	const models = validateModels(input.models);
	const apiKey = validateApiKey(input.apiKey);
	const catalogId = kind === "catalog" && typeof input.catalogId === "string"
		? input.catalogId.trim()
		: undefined;
	if (kind === "catalog" && (!catalogId || catalogId.length > 64))
		invalid("catalog connections need a catalogId");
	// 自定义连接不挂目录 id，避免以后拿目录里的品牌/端点冒充用户自己的目的地。
	if (kind === "custom" && input.catalogId !== undefined)
		invalid("custom connections must not carry a catalogId");
	return {
		providerId,
		kind,
		...(catalogId === undefined ? {} : { catalogId }),
		displayName: validateDisplayName(input.displayName, providerId),
		baseUrl,
		protocol,
		models,
		apiKey,
	};
}

export type ModelCredentialUpdate =
	| { action: "keep" }
	| { action: "replace"; apiKey: string }
	| { action: "remove" };

/**
 * AAD 绑定本人、连接、凭据版本与目标地址/协议：把密文搬到另一个用户、
 * 另一条连接或另一个目标地址后，认证 tag 校验必然失败。
 */
export function modelCredentialAad(input: {
	ownerId: string;
	connectionId: string;
	credentialVersion: number;
	baseUrl: string;
	protocol: ModelConnectionProtocol;
}): string {
	const parts = [
		input.ownerId,
		input.connectionId,
		String(input.credentialVersion),
		input.baseUrl,
		input.protocol,
	];
	return parts.map((part) => `${Buffer.byteLength(part, "utf8")}:${part}`).join("|");
}

export interface ResolvedModelCredential {
	connection: ModelConnectionView;
	apiKey: string;
	baseUrl: string;
	protocol: ModelConnectionProtocol;
	modelId: string;
}

function invalid(message: string): never {
	throw new ModelConnectionError("invalid_connection", message);
}

function validateProviderId(value: unknown): string {
	if (typeof value !== "string") invalid("providerId is required");
	const trimmed = value.trim();
	if (
		trimmed.length < 1 ||
		trimmed.length > 48 ||
		!providerIdPattern.test(trimmed) ||
		reservedProviderIds.has(trimmed)
	)
		invalid("providerId must be 1-48 lowercase kebab-case characters");
	return trimmed;
}

function validateDisplayName(value: unknown, fallback: string): string {
	if (value === undefined) return fallback;
	if (typeof value !== "string") invalid("displayName must be a string");
	const trimmed = value.trim();
	if (trimmed.length < 1 || trimmed.length > 80 || controlCharacters.test(trimmed))
		invalid("displayName must be 1-80 printable characters");
	return trimmed;
}

/** 只接受公网形态的 HTTPS 基础地址；具体出网策略由传输层在本层之外执行。 */
export function normalizeModelBaseUrl(value: unknown): string {
	if (typeof value !== "string") invalid("baseUrl is required");
	const trimmed = value.trim();
	if (trimmed.length < 1 || trimmed.length > 512) invalid("baseUrl is too long");
	let url: URL;
	try {
		url = new URL(trimmed);
	} catch {
		invalid("baseUrl must be an absolute URL");
	}
	if (url.protocol !== "https:") invalid("baseUrl must use https");
	if (url.username || url.password) invalid("baseUrl must not embed credentials");
	if (url.search || url.hash) invalid("baseUrl must not contain query or hash");
	return url.href.replace(/\/+$/u, "");
}

function validateProtocol(value: unknown): ModelConnectionProtocol {
	if (!modelConnectionProtocols.includes(value as ModelConnectionProtocol))
		invalid("unknown protocol");
	return value as ModelConnectionProtocol;
}

function validateModels(value: unknown): ModelConnectionModel[] {
	if (!Array.isArray(value) || value.length < 1 || value.length > 50)
		invalid("models must contain 1-50 entries");
	const seen = new Set<string>();
	const models: ModelConnectionModel[] = [];
	for (const item of value) {
		if (typeof item !== "object" || item === null || Array.isArray(item))
			invalid("model entries must be objects");
		const entry = item as Record<string, unknown>;
		const id = typeof entry.id === "string" ? entry.id.trim() : "";
		if (id.length < 1 || id.length > 160 || controlCharacters.test(id))
			invalid("model id must be 1-160 printable characters");
		if (seen.has(id)) invalid("model ids must be unique per connection");
		seen.add(id);
		const label = entry.label;
		if (label !== undefined && (typeof label !== "string" || label.trim().length > 160))
			invalid("model label must be at most 160 characters");
		models.push(label === undefined ? { id } : { id, label: String(label).trim() });
	}
	return models;
}

function validateApiKey(value: unknown): string {
	if (typeof value !== "string") invalid("apiKey is required");
	const trimmed = value.trim();
	if (trimmed.length < 8 || trimmed.length > 512 || controlCharacters.test(trimmed))
		invalid("apiKey must be 8-512 printable characters");
	return trimmed;
}

function validateKind(value: unknown): UserModelConnection["kind"] {
	if (value !== "catalog" && value !== "custom") invalid("kind must be catalog or custom");
	return value;
}

function project(
	connection: UserModelConnection,
	hasCredential: boolean,
): ModelConnectionView {
	return {
		id: connection.id,
		providerId: connection.providerId,
		kind: connection.kind,
		...(connection.catalogId === undefined ? {} : { catalogId: connection.catalogId }),
		displayName: connection.displayName,
		baseUrl: connection.baseUrl,
		protocol: connection.protocol,
		models: connection.models.map((model) => ({ ...model })),
		status: connection.status,
		version: connection.version,
		createdAt: connection.createdAt,
		updatedAt: connection.updatedAt,
		hasCredential,
		...(connection.verifiedAt === undefined ? {} : { verifiedAt: connection.verifiedAt }),
		...(connection.verifiedVersion === undefined ? {} : { verifiedVersion: connection.verifiedVersion }),
	};
}

function preferenceView(preference: UserModelPreference | null): ModelPreferenceView {
	return {
		connectionId: preference?.connectionId ?? null,
		modelId: preference?.modelId ?? null,
		version: preference?.version ?? 0,
	};
}

export class ModelConnectionService {
	constructor(
		private readonly storage: Storage,
		private readonly cipher: ModelCredentialCipher,
		private readonly now: () => string = () => new Date().toISOString(),
	) {}

	get activeKeyId(): string {
		return this.cipher.activeKeyId;
	}

	async view(ownerId: string): Promise<ModelConnectionsView> {
		return this.storage.transaction((tx) => this.viewIn(tx, ownerId));
	}

	async create(ownerId: string, rawInput: ModelConnectionInput, options: { verified?: boolean } = {}): Promise<ModelConnectionView> {
		const input = validateModelConnectionInput(rawInput);
		const { providerId, kind, baseUrl, protocol, models, apiKey, catalogId } = input;
		const at = this.now();
		const id = crypto.randomUUID();
		const connection: UserModelConnection = {
			id,
			ownerId,
			providerId,
			kind,
			...(catalogId === undefined ? {} : { catalogId }),
			displayName: input.displayName ?? providerId,
			baseUrl,
			protocol,
			models,
			status: "active",
			version: 1,
			...(options.verified ? { verifiedAt: at, verifiedVersion: 1 } : {}),
			createdAt: at,
			updatedAt: at,
		};
		const credential = this.encryptCredential(ownerId, connection, 1, apiKey, at);
		try {
			return await this.storage.transaction(async (tx) => {
				const existing = (await tx.userModelConnections.all()).find(
					(candidate) => candidate.ownerId === ownerId && candidate.providerId === providerId,
				);
				// 唯一约束是并发兜底；先查一次是为了给普通冲突返回明确错误。
				if (existing)
					throw new ModelConnectionError("connection_conflict", "providerId already exists");
				await tx.userModelConnections.put(connection);
				await tx.userModelCredentials.put(credential);
				return project(connection, true);
			});
		} catch (error) {
			if (error instanceof ModelConnectionError) throw error;
			// 并发下可能先通过预查、再撞唯一索引：映射成同一个冲突错误，不泄露驱动细节。
			const raced = await this.storage.transaction(async (tx) =>
				(await tx.userModelConnections.all()).some(
					(candidate) => candidate.ownerId === ownerId && candidate.providerId === providerId,
				),
			);
			if (raced)
				throw new ModelConnectionError("connection_conflict", "providerId already exists");
			throw error;
		}
	}

	async update(
		ownerId: string,
		connectionId: string,
		input: {
			expectedVersion: number;
			displayName?: string;
			models?: unknown;
			status?: unknown;
			baseUrl?: string;
			protocol?: unknown;
			credential?: ModelCredentialUpdate;
		},
		options: { verified?: boolean } = {},
	): Promise<ModelConnectionView> {
		return this.storage.transaction(async (tx) => {
			const connection = await this.requireOwned(tx, ownerId, connectionId);
			this.requireVersion(connection, input.expectedVersion);
			const credential = await tx.userModelCredentials.get(connectionId);
			const revocation = await tx.userModelRevocations.get(connectionId);
			const at = this.now();
			const update = input.credential ?? { action: "keep" };
			const models =
				input.models === undefined ? connection.models : validateModels(input.models);
			const baseUrl =
				input.baseUrl === undefined
					? connection.baseUrl
					: normalizeModelBaseUrl(input.baseUrl);
			const protocol =
				input.protocol === undefined
					? connection.protocol
					: validateProtocol(input.protocol);
			// 目标地址/协议变了就必须重填密钥：不能拿已存密钥去探另一个未确认的目的地。
			if (
				(baseUrl !== connection.baseUrl || protocol !== connection.protocol) &&
				update.action !== "replace"
			)
				invalid("changing the target requires a new API key");
			let status: UserModelConnection["status"] = connection.status;
			if (input.status !== undefined) {
				if (input.status !== "active" && input.status !== "disabled")
					invalid("status must be active or disabled");
				status = input.status;
			}
			let nextCredential: UserModelCredential | null = credential;
			const nextVersion = connection.version + 1;
			if (update.action === "replace") {
				nextCredential = this.encryptCredential(
					ownerId,
					{ id: connection.id, baseUrl, protocol },
					// 版本必须单调递增并越过墓碑，否则撤销后重设的密钥会被自己判为已撤销。
					Math.max(credential?.credentialVersion ?? 0, revocation?.credentialVersion ?? 0) + 1,
					validateApiKey(update.apiKey),
					at,
				);
				status = "active";
			}
			if (update.action === "remove") {
				await this.revoke(
					tx, connection,
					credential?.credentialVersion ?? connection.version,
					at, "credential_removed",
				);
				nextCredential = null;
				status = "disabled";
			}
			if (update.action === "keep" && status === "active" && !credential) {
				// 没有密钥就没有可调用的连接；不要留下“启用但无凭据”的中间态。
				invalid("cannot enable a connection without a credential");
			}
			if (status === "disabled")
				await this.clearPreference(tx, ownerId, connection.id, at);
			else {
				const preference = await tx.userModelPreferences.get(ownerId);
				if (preference?.connectionId === connection.id &&
					!models.some((model) => model.id === preference.modelId))
					await this.clearPreference(tx, ownerId, connection.id, at);
			}
			const next: UserModelConnection = {
				...connection,
				displayName:
					input.displayName === undefined
						? connection.displayName
						: validateDisplayName(input.displayName, connection.providerId),
				baseUrl,
				protocol,
				models,
				status,
				version: nextVersion,
				updatedAt: at,
			};
			// 任何配置变更都让旧的验证结果失效。
			delete next.verifiedAt;
			delete next.verifiedVersion;
			if (options.verified && update.action === "replace") {
				next.verifiedAt = at;
				next.verifiedVersion = nextVersion;
			}
			await tx.userModelConnections.put(next);
			if (nextCredential) await tx.userModelCredentials.put(nextCredential);
			else await tx.userModelCredentials.delete(connectionId);
			return project(next, nextCredential !== null);
		});
	}

	/** 删除密钥但保留连接元数据；连接立即不可调用，默认选择一并清空。 */
	async removeCredential(
		ownerId: string,
		connectionId: string,
		expectedVersion: number,
	): Promise<ModelConnectionView> {
		return this.update(ownerId, connectionId, {
			expectedVersion,
			credential: { action: "remove" },
		});
	}

	async delete(
		ownerId: string,
		connectionId: string,
		expectedVersion: number,
	): Promise<ModelConnectionsView> {
		return this.storage.transaction(async (tx) => {
			const connection = await this.requireOwned(tx, ownerId, connectionId);
			this.requireVersion(connection, expectedVersion);
			const at = this.now();
			await this.clearPreference(tx, ownerId, connection.id, at);
			const credential = await tx.userModelCredentials.get(connection.id);
			// 先写墓碑再删数据：即便后续恢复备份，重放时也知道这条连接已被删除。
			await this.revoke(tx, connection, credential?.credentialVersion ?? connection.version, at, "connection_deleted");
			await tx.userModelCredentials.delete(connection.id);
			await tx.userModelConnections.delete(connection.id);
			return this.viewIn(tx, ownerId);
		});
	}

	/** 记录一次成功验证；结果绑定到当前版本，配置变更后不再成立。 */
	async recordVerification(
		ownerId: string,
		connectionId: string,
		expectedVersion: number,
		at: string = this.now(),
	): Promise<ModelConnectionView> {
		return this.storage.transaction(async (tx) => {
			const connection = await this.requireOwned(tx, ownerId, connectionId);
			this.requireVersion(connection, expectedVersion);
			const credential = await tx.userModelCredentials.get(connection.id);
			if (!credential)
				throw new ModelConnectionError("credential_missing", "connection has no credential");
			const next: UserModelConnection = {
				...connection,
				verifiedAt: at,
				verifiedVersion: connection.version,
				updatedAt: at,
			};
			await tx.userModelConnections.put(next);
			return project(next, true);
		});
	}

	async setPreference(
		ownerId: string,
		input: {
			expectedVersion: number;
			connectionId?: string | null;
			modelId?: string | null;
		},
	): Promise<ModelPreferenceView> {
		return this.storage.transaction(async (tx) => {
			const current = await tx.userModelPreferences.get(ownerId);
			const version = current?.version ?? 0;
			if (input.expectedVersion !== version)
				throw new ModelConnectionError("connection_conflict", "preference version mismatch");
			const at = this.now();
			if (input.connectionId === null || input.connectionId === undefined) {
				if (input.modelId !== undefined && input.modelId !== null)
					invalid("modelId needs a connectionId");
				const cleared: UserModelPreference = {
					id: ownerId,
					ownerId,
					connectionId: null,
					modelId: null,
					version: version + 1,
					updatedAt: at,
				};
				await tx.userModelPreferences.put(cleared);
				return preferenceView(cleared);
			}
			const connection = await this.requireOwned(tx, ownerId, input.connectionId);
			if (connection.status !== "active")
				throw new ModelConnectionError("credential_missing", "connection is disabled");
			const credential = await tx.userModelCredentials.get(connection.id);
			if (!credential)
				throw new ModelConnectionError("credential_missing", "connection has no credential");
			// 恢复备份可能让旧密文重新出现；墓碑仍优先。
			if (await this.isRevoked(tx, connection.id, credential.credentialVersion))
				throw new ModelConnectionError("credential_unreadable", "credential was revoked");
			const modelId = typeof input.modelId === "string" ? input.modelId.trim() : "";
			if (!connection.models.some((model) => model.id === modelId))
				invalid("modelId is not part of this connection");
			const next: UserModelPreference = {
				id: ownerId,
				ownerId,
				connectionId: connection.id,
				modelId,
				version: version + 1,
				updatedAt: at,
			};
			await tx.userModelPreferences.put(next);
			return preferenceView(next);
		});
	}

	/**
	 * 只供已授权请求短暂解密。AAD 不匹配、keyId 丢失或连接不可用时抛错，
	 * 绝不回退到部署密钥、其他用户的密钥或明文。
	 */
	async resolveCredential(
		ownerId: string,
		connectionId: string,
		modelId?: string,
	): Promise<ResolvedModelCredential> {
		return this.storage.transaction(async (tx) => {
			const connection = await this.requireOwned(tx, ownerId, connectionId);
			if (connection.status !== "active")
				throw new ModelConnectionError("credential_missing", "connection is disabled");
			const credential = await tx.userModelCredentials.get(connection.id);
			if (!credential)
				throw new ModelConnectionError("credential_missing", "connection has no credential");
			// 已撤销的凭据即使被备份恢复回来也不可解密使用。
			if (await this.isRevoked(tx, connection.id, credential.credentialVersion))
				throw new ModelConnectionError("credential_unreadable", "credential was revoked");
			const resolvedModel = modelId === undefined
				? connection.models[0]?.id
				: connection.models.find((model) => model.id === modelId)?.id;
			if (!resolvedModel) invalid("modelId is not part of this connection");
			const plaintext = this.cipher.decrypt({
				ciphertext: {
					keyId: credential.keyId,
					algorithm: credential.algorithm,
					nonce: credential.nonce,
					ciphertext: credential.ciphertext,
					authTag: credential.authTag,
				},
				aad: modelCredentialAad({
					ownerId,
					connectionId: connection.id,
					credentialVersion: credential.credentialVersion,
					baseUrl: connection.baseUrl,
					protocol: connection.protocol,
				}),
			});
			if (plaintext === null)
				throw new ModelConnectionError("credential_unreadable", "credential cannot be decrypted");
			return {
				connection: project(connection, true),
				apiKey: plaintext,
				baseUrl: connection.baseUrl,
				protocol: connection.protocol,
				modelId: resolvedModel,
			};
		});
	}

	/**
	 * 主密钥轮换的受控入口：只把旧 keyId 的密文重新加密为新 activeKeyId。
	 * 每条记录在同一个事务内重读凭据与连接，删除/并发轮换不会把旧密文写回来。
	 */
	async rotateCredentials(): Promise<{ rotated: number; failed: number }> {
		let rotated = 0;
		let failed = 0;
		const ids = (await this.storage.transaction((tx) => tx.userModelCredentials.all()))
			.map((credential) => credential.id);
		for (const id of ids) {
			const outcome = await this.storage.transaction(async (tx) => {
				const credential = await tx.userModelCredentials.get(id);
				if (!credential || credential.keyId === this.cipher.activeKeyId) return "skipped" as const;
				const connection = await tx.userModelConnections.get(credential.connectionId);
				if (!connection || connection.ownerId !== credential.ownerId) return "failed" as const;
				const plaintext = this.cipher.decrypt({
					ciphertext: {
						keyId: credential.keyId,
						algorithm: credential.algorithm,
						nonce: credential.nonce,
						ciphertext: credential.ciphertext,
						authTag: credential.authTag,
					},
					aad: modelCredentialAad({
						ownerId: credential.ownerId,
						connectionId: credential.connectionId,
						credentialVersion: credential.credentialVersion,
						baseUrl: connection.baseUrl,
						protocol: connection.protocol,
					}),
				});
				if (plaintext === null) return "failed" as const;
				const at = this.now();
				await tx.userModelCredentials.put({
					...this.encryptCredential(credential.ownerId, connection, credential.credentialVersion, plaintext, at),
					createdAt: credential.createdAt,
				});
				return "rotated" as const;
			});
			if (outcome === "rotated") rotated++;
			if (outcome === "failed") failed++;
		}
		return { rotated, failed };
	}

	private encryptCredential(
		ownerId: string,
		connection: Pick<UserModelConnection, "id" | "baseUrl" | "protocol">,
		credentialVersion: number,
		apiKey: string,
		at: string,
	): UserModelCredential {
		const encrypted = this.cipher.encrypt({
			plaintext: apiKey,
			aad: modelCredentialAad({
				ownerId,
				connectionId: connection.id,
				credentialVersion,
				baseUrl: connection.baseUrl,
				protocol: connection.protocol,
			}),
		});
		return {
			id: connection.id,
			ownerId,
			connectionId: connection.id,
			credentialVersion,
			keyId: encrypted.keyId,
			algorithm: encrypted.algorithm,
			nonce: encrypted.nonce,
			ciphertext: encrypted.ciphertext,
			authTag: encrypted.authTag,
			createdAt: at,
			updatedAt: at,
		};
	}

	/** 只保留该连接的最高撤销版本，且不覆盖更晚的撤销记录。 */
	private async revoke(
		tx: Transaction,
		connection: Pick<UserModelConnection, "id" | "ownerId">,
		credentialVersion: number,
		at: string,
		reason: UserModelRevocation["reason"],
	): Promise<void> {
		const existing = await tx.userModelRevocations.get(connection.id);
		if (existing && existing.credentialVersion >= credentialVersion) return;
		await tx.userModelRevocations.put({
			id: connection.id,
			ownerId: connection.ownerId,
			connectionId: connection.id,
			credentialVersion,
			reason,
			revokedAt: existing?.revokedAt ?? at,
		});
	}

	private async isRevoked(tx: Transaction, connectionId: string, credentialVersion: number): Promise<boolean> {
		const revocation = await tx.userModelRevocations.get(connectionId);
		return revocation !== null && credentialVersion <= revocation.credentialVersion;
	}

	/** 运维用：导出撤销墓碑，供恢复备份后重放；不含密钥或密文。 */
	async listRevocations(): Promise<UserModelRevocation[]> {
		return (await this.storage.transaction((tx) => tx.userModelRevocations.all()))
			.sort((left, right) => left.connectionId.localeCompare(right.connectionId));
	}

	/**
	 * 恢复备份后重放撤销记录：默认只报告不写入（`apply: false`），
	 * 确认后再执行。凭据版本高于墓碑时跳过，避免误删轮换后的新密钥。
	 */
	async replayRevocations(
		entries: readonly UserModelRevocation[],
		options: { apply?: boolean } = {},
	): Promise<RevocationReplayReport> {
		const apply = options.apply === true;
		const report: RevocationReplayReport = { skipped: 0, disabled: 0, tombstoned: 0 };
		for (const entry of entries) {
			if (typeof entry?.connectionId !== "string" || typeof entry.ownerId !== "string" ||
				!Number.isInteger(entry.credentialVersion) || entry.credentialVersion < 1) continue;
			const outcome = await this.storage.transaction(async (tx) => {
				const connection = await tx.userModelConnections.get(entry.connectionId);
				const credential = await tx.userModelCredentials.get(entry.connectionId);
				if (connection && connection.ownerId !== entry.ownerId)
					throw new ModelConnectionError("connection_not_found", "revocation owner mismatch");
				if (connection && (!credential || credential.credentialVersion <= entry.credentialVersion)) {
					if (!apply) return "disabled" as const;
					const at = this.now();
					await this.revoke(tx, connection, entry.credentialVersion, at, entry.reason);
					await tx.userModelCredentials.delete(connection.id);
					const next: UserModelConnection = {
						...connection,
						status: "disabled",
						version: connection.version + 1,
						updatedAt: at,
					};
					delete next.verifiedAt;
					delete next.verifiedVersion;
					await tx.userModelConnections.put(next);
					await this.clearPreference(tx, connection.ownerId, connection.id, at);
					return "disabled" as const;
				}
				if (connection) return "skipped" as const;
				if (!apply) return "tombstoned" as const;
				await this.revoke(
					tx, { id: entry.connectionId, ownerId: entry.ownerId },
					entry.credentialVersion, this.now(), entry.reason,
				);
				return "tombstoned" as const;
			});
			report[outcome]++;
		}
		return report;
	}

	private async requireOwned(
		tx: Transaction,
		ownerId: string,
		connectionId: string,
	): Promise<UserModelConnection> {
		const connection = await tx.userModelConnections.get(connectionId);
		// 他人的 ID 与不存在同样处理，不泄露存在性。
		if (!connection || connection.ownerId !== ownerId)
			throw new ModelConnectionError("connection_not_found", "connection not found");
		return connection;
	}

	private requireVersion(connection: UserModelConnection, expectedVersion: number): void {
		if (!Number.isInteger(expectedVersion) || expectedVersion !== connection.version)
			throw new ModelConnectionError("connection_conflict", "connection version mismatch");
	}

	private async clearPreference(
		tx: Transaction,
		ownerId: string,
		connectionId: string,
		at: string,
	): Promise<void> {
		const preference = await tx.userModelPreferences.get(ownerId);
		if (preference?.connectionId !== connectionId) return;
		await tx.userModelPreferences.put({
			id: ownerId,
			ownerId,
			connectionId: null,
			modelId: null,
			version: preference.version + 1,
			updatedAt: at,
		});
	}

	private async viewIn(tx: Transaction, ownerId: string): Promise<ModelConnectionsView> {
		const connections = (await tx.userModelConnections.all())
			.filter((connection) => connection.ownerId === ownerId)
			.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
		const items: ModelConnectionView[] = [];
		for (const connection of connections) {
			const credential = await tx.userModelCredentials.get(connection.id);
			// 被撤销的连接在界面与接口上都表现为停用，不依赖是否已重放。
			const revoked = credential !== null && await this.isRevoked(tx, connection.id, credential.credentialVersion);
			items.push(project(revoked ? { ...connection, status: "disabled" } : connection, credential !== null && !revoked));
		}
		return {
			connections: items,
			preference: preferenceView(await tx.userModelPreferences.get(ownerId)),
		};
	}
}
