import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { consoleClient, type components } from "../../../adpulse-client";
import { Button } from "../../../components/ui/button";
import {
	Dialog,
	DialogCloseButton,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "../../../components/ui/dialog";
import { Input } from "../../../components/ui/input";

export type ModelCatalog = components["schemas"]["TaskDraftModelCatalog"];
export type ModelCatalogProvider = components["schemas"]["TaskDraftCatalogProvider"];
export type ModelSelection = components["schemas"]["TaskDraftModelSelection"];

export const modelCatalogKey = ["task-draft-models"] as const;

const searchPlaceholder = "搜索供应商或模型";
const keyPlaceholder = "粘贴你的 API Key";
const statusText = {
	idle: "尚未验证",
	ok: "连接已保存，可直接在任务中使用",
	error: "连接未通过。请检查密钥、模型与账户额度后重试。",
} as const;

type Status = keyof typeof statusText;
type Mode = "catalog" | "custom";

export function selectionLabel(catalog: ModelCatalog | undefined, selection: ModelSelection): string {
	const shared = catalog?.shared.find((item) => item.provider === selection.provider && item.model === selection.model);
	if (shared) return shared.label;
	const connection = catalog?.connections.find((item) => item.provider === selection.provider && item.model === selection.model);
	if (connection) return connection.label;
	const provider = catalog?.providers.find((item) => item.id === selection.provider);
	const model = provider?.models.find((item) => item.id === selection.model);
	return model?.name ?? selection.model;
}

/**
 * 全局模型配置窗口：左侧是本人连接与 pi-ai 目录，右侧是配置表单。
 * 目录只展示真实 SDK 条目；未接通的供应商显示原因，不提供会失败的保存按钮。
 * 密钥只写、不回显，仅保存在服务端内存（最多 8 小时）。
 */
export function ModelConfigDialog({ open, onOpenChange, selection, onUse }: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	selection?: ModelSelection | undefined;
	onUse?: (selection: ModelSelection) => void;
}) {
	const queryClient = useQueryClient();
	const [mode, setMode] = useState<Mode>("catalog");
	const [draft, setDraft] = useState<ModelSelection | null>(null);
	const [apiKey, setApiKey] = useState("");
	const [status, setStatus] = useState<Status>("idle");
	const [working, setWorking] = useState(false);
	const [search, setSearch] = useState("");

	const { data, isPending, isError } = useQuery({
		queryKey: modelCatalogKey,
		enabled: open,
		queryFn: async () => {
			const result = await consoleClient.GET("/api/task-drafts/models");
			if (!result.data) throw new Error("模型目录不可用");
			return result.data;
		},
	});

	useEffect(() => {
		if (!open) return;
		setMode("catalog");
		setDraft(selection ?? null);
		setApiKey("");
		setStatus("idle");
		setSearch("");
	}, [open, selection]);

	useEffect(() => {
		if (open && !draft && data?.defaultSelection) setDraft(data.defaultSelection);
	}, [open, draft, data]);

	const providers = data?.providers ?? [];
	const connections = data?.connections ?? [];
	const shared = data?.shared ?? [];
	const provider = draft ? providers.find((item) => item.id === draft.provider) : undefined;
	const connection = draft
		? connections.find((item) => item.provider === draft.provider && item.model === draft.model)
		: undefined;
	const sharedRoute = draft
		? shared.find((item) => item.provider === draft.provider && item.model === draft.model)
		: undefined;

	const supported = useMemo(() => providers.filter((item) => item.supported), [providers]);
	const unsupported = useMemo(() => providers.filter((item) => !item.supported), [providers]);
	const keyword = search.trim().toLowerCase();
	const matches = (name: string, models: readonly { id: string; name: string }[]) =>
		!keyword || name.toLowerCase().includes(keyword) ||
		models.some((model) => model.id.toLowerCase().includes(keyword) || model.name.toLowerCase().includes(keyword));

	function pickProvider(next: ModelCatalogProvider) {
		// Unsupported providers have no callable model; keep the id so the panel can
		// explain why instead of silently ignoring the click.
		setDraft({ provider: next.id, model: next.models[0]?.id ?? "" });
		setApiKey("");
		setStatus("idle");
	}

	function pickConnection(next: { provider: string; model: string }) {
		setDraft({ provider: next.provider, model: next.model });
		setApiKey("");
		setStatus("idle");
	}

	async function runTest() {
		if (!draft || working || apiKey.trim().length < 8) return;
		setWorking(true);
		setStatus("idle");
		try {
			const result = await consoleClient.POST("/api/task-drafts/models/test", {
				body: { ...draft, apiKey: apiKey.trim() },
			});
			setStatus(result.data?.ok ? "ok" : "error");
		} catch {
			setStatus("error");
		} finally {
			setWorking(false);
		}
	}

	async function save() {
		if (!draft || working || apiKey.trim().length < 8) return;
		setWorking(true);
		setStatus("idle");
		try {
			const result = await consoleClient.PUT("/api/task-drafts/models", {
				body: { ...draft, apiKey: apiKey.trim() },
			});
			if (!result.data) throw new Error("连接未保存");
			queryClient.setQueryData(modelCatalogKey, result.data);
			setApiKey("");
			setStatus("ok");
			onUse?.(draft);
		} catch {
			setStatus("error");
		} finally {
			setWorking(false);
		}
	}

	async function disconnect() {
		if (!draft || working) return;
		setWorking(true);
		try {
			const result = await consoleClient.DELETE("/api/task-drafts/models", {
				params: { query: { provider: draft.provider, model: draft.model } },
			});
			if (!result.data) throw new Error("连接未断开");
			queryClient.setQueryData(modelCatalogKey, result.data);
			setStatus("idle");
		} catch {
			setStatus("error");
		} finally {
			setWorking(false);
		}
	}

	const canSubmit = Boolean(draft && provider?.supported && apiKey.trim().length >= 8 && !working);
	const alreadyConnected = Boolean(connection && !sharedRoute);

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent aria-describedby="model-config-summary">
				<DialogHeader>
					<div className="space-y-0.5">
						<DialogTitle>模型配置</DialogTitle>
						<DialogDescription id="model-config-summary">
							连接供应商或自定义 API，用于任务草稿的辅助填写。密钥只写不回显。
						</DialogDescription>
					</div>
					<DialogCloseButton />
				</DialogHeader>

				<div className="grid min-h-0 flex-1 sm:grid-cols-[13.5rem_1fr]">
					<aside className="flex min-h-0 flex-col gap-2 border-b p-3 sm:border-r sm:border-b-0">
						<Input value={search} onChange={(event) => setSearch(event.target.value)}
							placeholder={searchPlaceholder} aria-label={searchPlaceholder} />
						<div className="min-h-0 flex-1 space-y-3 overflow-y-auto pr-1">
							{isPending ? <p role="status" className="text-xs text-muted-foreground">正在读取模型目录…</p> : null}
							{isError ? <p role="alert" className="text-xs text-destructive">模型目录暂时不可用，请稍后重试。</p> : null}

							{connections.length ? (
								<ProviderGroup title="我的连接">
									{connections.map((item) => (
										<ProviderButton key={item.provider + ":" + item.model}
											title={item.label} subtitle="已连接" active={draft?.provider === item.provider && draft.model === item.model}
											onClick={() => pickConnection(item)} />
									))}
								</ProviderGroup>
							) : null}

							{shared.length ? (
								<ProviderGroup title="部署提供">
									{shared.map((item) => (
										<ProviderButton key={"shared:" + item.provider + ":" + item.model}
											title={item.label} subtitle="使用部署密钥" active={draft?.provider === item.provider && draft.model === item.model}
											onClick={() => pickConnection(item)} />
									))}
								</ProviderGroup>
							) : null}

							<ProviderGroup title="可直连供应商">
								{supported.filter((item) => matches(item.name, item.models)).map((item) => (
									<ProviderButton key={item.id} title={item.name}
										subtitle={item.models.length + " 个模型"} active={provider?.id === item.id && !sharedRoute}
										onClick={() => pickProvider(item)} />
								))}
								{supported.length === 0 && !isPending ? (
									<p className="text-xs text-muted-foreground">暂无可直连供应商。</p>
								) : null}
							</ProviderGroup>

							{unsupported.length ? (
								<ProviderGroup title="其他供应商">
									{unsupported.filter((item) => matches(item.name, [])).map((item) => (
										<ProviderButton key={item.id} title={item.name} subtitle="暂不支持" muted
											active={provider?.id === item.id} onClick={() => pickProvider(item)} />
									))}
								</ProviderGroup>
							) : null}
						</div>
						<Button type="button" variant="outline" size="sm" className="justify-center"
							onClick={() => { setMode("custom"); setStatus("idle"); }}>
							＋ 自定义服务商
						</Button>
						<p className="text-[11px] leading-tight text-muted-foreground">
							目前为临时连接：密钥只在服务端内存保留最多 8 小时，服务重启后需重新填写。
						</p>
					</aside>

					<section className="flex min-h-0 flex-col">
						<div className="flex gap-1 border-b px-4 py-2">
							<TabButton active={mode === "catalog"} onClick={() => setMode("catalog")}>第三方供应商</TabButton>
							<TabButton active={mode === "custom"} onClick={() => setMode("custom")}>自定义 API</TabButton>
						</div>

						<div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
							{mode === "custom" ? <CustomApiForm /> : (
								<ProviderPanel
									draft={draft} provider={provider} sharedRoute={sharedRoute} alreadyConnected={alreadyConnected}
									connectionModel={connection?.model} apiKey={apiKey} working={working}
									onApiKey={setApiKey} onModel={(model) => draft && setDraft({ ...draft, model })}
									onDisconnect={() => void disconnect()} />
							)}
						</div>

						<footer className="flex flex-wrap items-center justify-between gap-3 border-t px-4 py-3">
							<p role="status" className={status === "error" ? "text-xs text-destructive" : "text-xs text-muted-foreground"}>
								{status === "ok" ? statusText.ok : status === "error" ? statusText.error : sharedRoute ? "由部署者提供，可直接选用" : provider && !provider.supported ? "等待协议或认证适配" : statusText.idle}
							</p>
							{mode === "custom" || (provider && !provider.supported) ? null : sharedRoute ? (
								<Button type="button" onClick={() => {
									if (!draft) return;
									onUse?.(draft);
									onOpenChange(false);
								}}>使用此模型</Button>
							) : (
								<div className="flex gap-2">
									<Button type="button" variant="outline" disabled={!canSubmit} onClick={() => void runTest()}>
										{working ? "正在测试…" : "测试连接"}
									</Button>
									<Button type="button" disabled={!canSubmit} onClick={() => void save()}>
										{working ? "正在保存…" : alreadyConnected ? "重新验证并保存" : "保存并使用"}
									</Button>
								</div>
							)}
						</footer>
					</section>
				</div>
			</DialogContent>
		</Dialog>
	);
}

function ProviderGroup({ title, children }: { title: string; children: ReactNode }) {
	return (
		<div className="space-y-1">
			<p className="px-1 text-[11px] font-medium tracking-wide text-muted-foreground">{title}</p>
			<div className="space-y-0.5">{children}</div>
		</div>
	);
}

function ProviderButton({ title, subtitle, active, muted, onClick }: {
	title: string;
	subtitle: string;
	active: boolean;
	muted?: boolean;
	onClick: () => void;
}) {
	return (
		<button type="button" onClick={onClick} aria-pressed={active}
			className={[
				"block w-full rounded-lg px-2 py-1.5 text-left text-sm transition-colors",
				active ? "bg-primary/10 text-primary ring-1 ring-primary/30" : "hover:bg-muted",
				muted ? "text-muted-foreground" : "",
			].join(" ")}>
			<span className="block truncate font-medium">{title}</span>
			<span className="block truncate text-[11px] text-muted-foreground">{subtitle}</span>
		</button>
	);
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
	return (
		<button type="button" onClick={onClick} aria-pressed={active}
			className={[
				"rounded-md px-2.5 py-1 text-xs transition-colors",
				active ? "bg-muted font-medium text-foreground" : "text-muted-foreground hover:bg-muted/60",
			].join(" ")}>
			{children}
		</button>
	);
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
	return (
		<label className="block space-y-1 text-sm">
			<span className="font-medium">{label}</span>
			{children}
			{hint ? <span className="block text-[11px] text-muted-foreground">{hint}</span> : null}
		</label>
	);
}

function ProviderPanel({ draft, provider, sharedRoute, alreadyConnected, connectionModel, apiKey, working, onApiKey, onModel, onDisconnect }: {
	draft: ModelSelection | null;
	provider: ModelCatalogProvider | undefined;
	sharedRoute: { provider: string; model: string; label: string } | undefined;
	alreadyConnected: boolean;
	connectionModel: string | undefined;
	apiKey: string;
	working: boolean;
	onApiKey: (value: string) => void;
	onModel: (value: string) => void;
	onDisconnect: () => void;
}) {
	if (!draft) return <p className="text-sm text-muted-foreground">从左侧选择供应商，或添加自定义服务商。</p>;
	if (sharedRoute) {
		return (
			<div className="space-y-2 text-sm">
				<p className="font-medium">{sharedRoute.label}</p>
				<p className="text-muted-foreground">该模型由部署者配置密钥，不消耗你的个人额度。选择后仅用于本次任务。</p>
			</div>
		);
	}
	if (!provider) return <p className="text-sm text-muted-foreground">未找到该供应商目录项。</p>;
	if (!provider.supported) {
		return (
			<div className="space-y-2 text-sm">
				<p className="font-medium">{provider.name}</p>
				<p role="note" className="rounded-lg border border-dashed px-3 py-2 text-muted-foreground">
					{provider.reason ?? "该供应商暂不支持个人 API Key 直连。"}
				</p>
				<p className="text-xs text-muted-foreground">目录来自锁定的 pi-ai 版本，接入范围按真实协议能力列出，不做品牌白名单。</p>
			</div>
		);
	}
	return (
		<div className="space-y-3">
			<Field label="供应商名称">
				<Input value={provider.name} readOnly disabled />
			</Field>
			<Field label="API Key" hint={alreadyConnected ? "已保存的密钥不会回显；更换请重新填写。" : "只写字段，保存后不再显示。"}>
				<Input type="password" autoComplete="new-password" maxLength={512} value={apiKey} disabled={working}
					placeholder={alreadyConnected ? "已保存，如需更换请重新填写" : keyPlaceholder}
					onChange={(event) => onApiKey(event.target.value)} />
			</Field>
			<Field label="API Base URL" hint="由供应商目录提供，普通用户无需填写。">
				<Input value={provider.baseUrl ?? ""} readOnly disabled />
			</Field>
			<Field label="Model ID" hint={"来自锁定的 pi-ai 目录（" + provider.models.length + " 个模型），选中后仍可修改。"}>
				<div className="flex gap-2">
					<select value={draft.model} onChange={(event) => onModel(event.target.value)} disabled={working}
						className="h-8 min-w-0 flex-1 rounded-lg border bg-transparent px-2 text-sm">
						{provider.models.map((model) => (
							<option key={model.id} value={model.id}>{model.name + "（" + model.id + "）"}</option>
						))}
					</select>
					{connectionModel ? (
						<Button type="button" variant="outline" size="sm" disabled={working} onClick={onDisconnect}>
							断开连接
						</Button>
					) : null}
				</div>
			</Field>
			<details className="rounded-lg border px-3 py-2 text-sm">
				<summary className="cursor-pointer text-xs font-medium">高级选项</summary>
				<dl className="mt-2 space-y-1 text-xs text-muted-foreground">
					<div className="flex justify-between gap-4">
						<dt>协议</dt>
						<dd>OpenAI Chat Completions</dd>
					</div>
					<div className="flex justify-between gap-4">
						<dt>请求地址</dt>
						<dd className="truncate">{(provider.baseUrl ?? "") + "/chat/completions"}</dd>
					</div>
					<div className="flex justify-between gap-4">
						<dt>凭据</dt>
						<dd>服务端内存，最多 8 小时</dd>
					</div>
				</dl>
			</details>
		</div>
	);
}

function CustomApiForm() {
	return (
		<div className="space-y-3">
			<p role="note" className="rounded-lg border border-dashed px-3 py-2 text-xs text-muted-foreground">
				自定义 API 需要服务端受控出网（拒绝内网地址、绑定解析结果、禁止重定向），将在 #86 的下一阶段接通。
				当前版本不保存自定义地址，避免把密钥转发到未校验的主机。
			</p>
			<Field label="供应商名称">
				<Input placeholder="例如：公司内部网关" disabled />
			</Field>
			<Field label="API Base URL" hint="不是完整的聊天请求地址。">
				<Input placeholder="https://api.example.com/v1" disabled />
			</Field>
			<Field label="Model ID">
				<Input placeholder="例如：mimo-v2-flash" disabled />
			</Field>
			<Field label="API Key">
				<Input type="password" placeholder={keyPlaceholder} disabled />
			</Field>
		</div>
	);
}
