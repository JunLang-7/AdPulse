import {
	SOURCE_DEFINITIONS,
	SourceDisabledError,
	latestDueSlot,
	isSlotPending,
	type SourceService,
} from "@adpluse/core";

const TICK_MS = 60_000;

function sleep(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		const finish = () => {
			clearTimeout(timer);
			signal.removeEventListener("abort", finish);
			resolve();
		};
		const timer = setTimeout(finish, ms);
		signal.addEventListener("abort", finish, { once: true });
		if (signal.aborted) finish();
	});
}

/**
 * Polls each source once per scheduled slot. Restarts catch up on the current
 * slot only; earlier missed slots are not replayed.
 */
export async function runSources(
	sources: SourceService,
	signal: AbortSignal,
	options: { tickMs?: number; now?: () => string } = {},
): Promise<void> {
	const now = options.now ?? (() => new Date().toISOString());
	const tickMs = options.tickMs ?? TICK_MS;
	while (!signal.aborted) {
		const stamp = now();
		const slot = latestDueSlot(stamp);
		for (const key of Object.keys(SOURCE_DEFINITIONS)) {
			// Retention is independent of polling: it also runs while a source is
			// stopped or collection is off, so old snapshots do not accumulate.
			try {
				await sources.pruneIfDue(key, stamp);
			} catch {
				console.error(`source ${key} retention failed; will retry next tick`);
			}
			try {
				const last = await sources.lastRun(key);
				if (isSlotPending(last?.startedAt ?? null, slot))
					await sources.sync(key, stamp);
			} catch (error) {
				// Collection disabled (Gate 0 unsigned) is a terminal condition.
				if (error instanceof SourceDisabledError) return;
				console.error(`source ${key} tick failed; will retry next slot`);
			}
		}
		await sleep(tickMs, signal);
	}
}
