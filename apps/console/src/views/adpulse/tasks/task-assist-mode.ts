export const assistModeStorageKey = "adpulse.taskAssistMode";

/**
 * 用户怎么拿建议：
 * - form：一次整理全部字段，五个字段的建议一起列出来；
 * - stage：每一步只整理这一步的字段。
 */
export type AssistMode = "form" | "stage";

export const assistModeOptions = [
	{
		id: "form",
		title: "整表单一次给",
		summary: "点一次，把三个阶段的说明一起整理，每个字段的建议一起列出来。",
		detail: "适合已经把情况写清楚、想一次挑完的时候。",
	},
	{
		id: "stage",
		title: "按阶段一次次给",
		summary: "每一步只整理这一步要填的字段，看完当前这一步再往下走。",
		detail: "适合边想边填、不想一次看到太多建议的时候。",
	},
] as const satisfies readonly { id: AssistMode; title: string; summary: string; detail: string }[];

export function assistModeLabel(mode: AssistMode | undefined): string {
	return mode === "stage" ? "按阶段一次次给" : "整表单一次给";
}

type StorageLike = Pick<Storage, "getItem" | "setItem">;

/** 读不到或值不合法都当作没选过，下次打开再问一次。 */
export function readAssistMode(storage?: StorageLike): AssistMode | undefined {
	const box = storage ?? safeStorage();
	if (!box) return;
	try {
		const value = box.getItem(assistModeStorageKey);
		return value === "form" || value === "stage" ? value : undefined;
	} catch {
		return;
	}
}

/** 记不住也不影响使用：隐私模式下只是下次再问一遍。 */
export function writeAssistMode(mode: AssistMode, storage?: StorageLike): void {
	const box = storage ?? safeStorage();
	if (!box) return;
	try {
		box.setItem(assistModeStorageKey, mode);
	} catch {
		// 浏览器拒绝写入时保持沉默，不在界面上报错。
	}
}

function safeStorage(): StorageLike | undefined {
	try {
		return typeof window === "undefined" ? undefined : window.localStorage;
	} catch {
		return;
	}
}
