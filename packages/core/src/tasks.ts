import { createHash } from "node:crypto";
import { validateStrategy, type Strategy } from "./domain/strategy.js";
import type { Storage } from "./ports/storage.js";
import type { Task, TaskVersion } from "./state/model.js";

export interface TaskInput {
	product: string;
	strategy: Strategy;
	observation: TaskVersion["observation"];
	rules: TaskVersion["rules"];
}

export class TaskInputValidationError extends Error {
	constructor(
		readonly fieldPath: string,
		message: string,
	) {
		super(message);
		this.name = "TaskInputValidationError";
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

function validateInput(input: TaskInput): void {
	if (!input || typeof input.product !== "string" || !input.product.trim())
		throw new Error("invalid task product");
	validateStrategy(input.strategy, {
		maxBudgetChangeRatio: 1,
		maxBidChangeRatio: 1,
	});
	if (!input.observation || typeof input.observation !== "object")
		throw new Error("invalid task observation");
	const { startsAt, endsAt } = input.observation;
	if (
		(startsAt !== undefined && !Number.isFinite(Date.parse(startsAt))) ||
		(endsAt !== undefined && !Number.isFinite(Date.parse(endsAt))) ||
		(startsAt !== undefined &&
			endsAt !== undefined &&
			Date.parse(startsAt) > Date.parse(endsAt))
	)
		throw new TaskInputValidationError(
			"observation.startsAt",
			"invalid task observation period",
		);
	if (!input.rules || typeof input.rules !== "object")
		throw new Error("invalid task rules");
	for (const key of [
		"statWindowDays",
		"alertThresholdMinor",
		"minimumSpendMinor",
		"minimumConsultations",
		"handlingDeadlineHours",
		"maxPushRounds",
	] as const) {
		const value = input.rules[key];
		if (
			value !== undefined &&
			(!Number.isSafeInteger(value) || value < (key === "maxPushRounds" ? 1 : 0))
		)
			throw new Error(`invalid task rule ${key}`);
	}
	if (
		input.rules.metricKey !== undefined &&
		input.rules.metricKey !== "cost_per_consultation"
	)
		throw new Error("invalid task rule metricKey");
	for (const key of ["metricDefinition", "currency", "unit"] as const) {
		const value = input.rules[key];
		if (value !== undefined && (typeof value !== "string" || !value.trim()))
			throw new Error(`invalid task rule ${key}`);
	}
}

/** Owner-scoped, immutable-versioned task configuration used as a decision baseline. */
export class TaskService {
	constructor(
		private readonly storage: Storage,
		private readonly now: () => string = () => new Date().toISOString(),
		private readonly id: () => string = () => crypto.randomUUID(),
	) {}

	async create(
		ownerId: string,
		key: string,
		input: TaskInput,
	): Promise<TaskVersion> {
		validateInput(input);
		return this.storage.transaction(async (tx) => {
			const operationId = JSON.stringify([ownerId, "create", key]);
			const existing = await tx.taskOperations.get(operationId);
			const requestDigest = digest(input);
			if (existing) {
				if (existing.digest !== requestDigest)
					throw new Error("idempotency conflict");
				const version = await tx.taskVersions.get(
					`${existing.taskId}:${existing.taskVersion}`,
				);
				if (!version) throw new Error("task operation result missing");
				return version;
			}
			const taskId = this.id();
			const createdAt = this.now();
			const task: Task = {
				id: taskId,
				ownerId,
				currentVersion: 1,
				createdAt,
			};
			const version = this.makeVersion(taskId, 1, input, createdAt);
			await tx.tasks.put(task);
			await tx.taskVersions.put(version);
			await tx.taskOperations.put({
				id: operationId,
				ownerId,
				operation: "create",
				key,
				digest: requestDigest,
				taskId,
				taskVersion: 1,
			});
			return version;
		});
	}

	async revise(
		ownerId: string,
		taskId: string,
		expectedVersion: number,
		key: string,
		input: TaskInput,
	): Promise<TaskVersion> {
		validateInput(input);
		return this.storage.transaction(async (tx) => {
			const operationId = JSON.stringify([ownerId, "revise", key]);
			const existing = await tx.taskOperations.get(operationId);
			const requestDigest = digest({ taskId, expectedVersion, input });
			if (existing) {
				if (existing.digest !== requestDigest)
					throw new Error("idempotency conflict");
				const version = await tx.taskVersions.get(
					`${existing.taskId}:${existing.taskVersion}`,
				);
				if (!version) throw new Error("task operation result missing");
				return version;
			}
			const task = await tx.tasks.get(taskId);
			if (!task || task.ownerId !== ownerId)
				throw new Error("task not found");
			if (task.currentVersion !== expectedVersion)
				throw new Error("task version conflict");
			const nextVersion = expectedVersion + 1;
			const version = this.makeVersion(taskId, nextVersion, input, this.now());
			await tx.taskVersions.put(version);
			await tx.tasks.put({ ...task, currentVersion: nextVersion });
			await tx.taskOperations.put({
				id: operationId,
				ownerId,
				operation: "revise",
				key,
				digest: requestDigest,
				taskId,
				taskVersion: nextVersion,
			});
			return version;
		});
	}

	async get(ownerId: string, taskId: string): Promise<TaskVersion | null> {
		return this.storage.transaction(async (tx) => {
			const task = await tx.tasks.get(taskId);
			if (!task || task.ownerId !== ownerId) return null;
			return tx.taskVersions.get(`${taskId}:${task.currentVersion}`);
		});
	}

	async getVersion(
		ownerId: string,
		taskId: string,
		version: number,
	): Promise<TaskVersion | null> {
		return this.storage.transaction(async (tx) => {
			const task = await tx.tasks.get(taskId);
			if (!task || task.ownerId !== ownerId) return null;
			return tx.taskVersions.get(`${taskId}:${version}`);
		});
	}

	async list(ownerId: string): Promise<TaskVersion[]> {
		return this.storage.transaction(async (tx) => {
			const tasks = (await tx.tasks.all()).filter(
				(task) => task.ownerId === ownerId,
			);
			const versions = await Promise.all(
				tasks.map((task) =>
					tx.taskVersions.get(`${task.id}:${task.currentVersion}`),
				),
			);
			return versions.filter((version): version is TaskVersion => version !== null);
		});
	}

	private makeVersion(
		taskId: string,
		version: number,
		input: TaskInput,
		createdAt: string,
	): TaskVersion {
		return {
			id: `${taskId}:${version}`,
			taskId,
			version,
			product: input.product.trim(),
			strategy: structuredClone(input.strategy),
			observation: structuredClone(input.observation),
			rules: structuredClone(input.rules),
			createdAt,
		};
	}
}
