// 轮询断言引擎：等状态迁移，而不是等固定时长。
// 时间与 sleep 可注入，便于测试不依赖真实时钟。

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 反复读取状态直到满足条件或超时。
 * 超时不抛错：调用方据 matched 判定为 blocked（等待外部动作）而非 fail。
 *
 * @template T
 * @param {{
 *   read: () => Promise<T>,
 *   until: (state: T) => boolean,
 *   intervalMs?: number,
 *   timeoutMs?: number,
 *   now?: () => number,
 *   sleep?: (ms: number) => Promise<void>,
 *   onSample?: (state: T, elapsedMs: number) => void,
 * }} options
 * @returns {Promise<{ matched: boolean, state: T | undefined, elapsedMs: number, samples: number, error?: Error }>}
 */
export async function pollUntil(options) {
	const {
		read,
		until,
		intervalMs = 1_000,
		timeoutMs = 120_000,
		now = Date.now,
		sleep = defaultSleep,
		onSample,
	} = options;
	if (timeoutMs <= 0) throw new Error("timeoutMs 必须为正数");
	if (intervalMs <= 0) throw new Error("intervalMs 必须为正数");

	const started = now();
	let samples = 0;
	let last;
	for (;;) {
		let state;
		try {
			state = await read();
		} catch (error) {
			return {
				matched: false,
				state: last,
				elapsedMs: now() - started,
				samples,
				error: error instanceof Error ? error : new Error(String(error)),
			};
		}
		samples += 1;
		last = state;
		const elapsedMs = now() - started;
		onSample?.(state, elapsedMs);
		if (until(state)) return { matched: true, state, elapsedMs, samples };
		if (elapsedMs + intervalMs > timeoutMs)
			return { matched: false, state, elapsedMs, samples };
		await sleep(intervalMs);
	}
}
