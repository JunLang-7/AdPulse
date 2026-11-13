import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
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
import { safeReturnTo } from "../../auth/return-to";

export type ModelCatalog = components["schemas"]["TaskDraftModelCatalog"];
export type ModelCatalogProvider = components["schemas"]["TaskDraftCatalogProvider"];
export type ModelConnection = components["schemas"]["ModelConnectionView"];
export type ModelConnectionList = components["schemas"]["ModelConnectionList"];
export type ModelConnectionInput = components["schemas"]["ModelConnectionInput"];

/** 任务页的选择：本人持久连接，或部署者提供的临时路由。 */
export type TaskModelChoice =
	| { connectionId: string; model: string }
	| { provider: string; model: string };

export const modelCatalogKey = ["task-draft-models"] as const;
export const modelConnectionsKey = ["model-connections"] as const;

const keyPlaceholder = "粘贴你的 API Key";
const protocolHint = "OpenAI Chat Completions（其他协议尚未接通）";

export function selectionLabel(choice: TaskModelChoice | undefined, connections: ModelConnectionList | undefined, catalog: ModelCatalog | undefined): string {
	if (!choice) return "选择模型";
	if ("connectionId" in choice) {
		const connection = connections?.connections.find((item) => item.id === choice.connectionId);
		return connection ? `${connection.displayName} · ${choice.model}` : choice.model;
	}
	const shared = catalog?.shared.find((item) => item.provider === choice.provider && item.model === choice.model);
	return shared?.label ?? choice.model;
}

/**
 * 统一模型配置窗口：左侧是本人连接、部署提供和 pi-ai 目录，右侧是配置表单。
 * 保存前先用固定合成短句测试；密钥只写、不回显，服务端加密保存。
 */
export function ModelConfigDialog({ open, onOpenChange, choice, onUse }: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	choice?: TaskModelChoice | undefined;
	onUse?: (choice: TaskModelChoice) => void;
}) {
	const queryClient = useQueryClient();
	const [mode, setMode] = useState<"catalog" | "custom">("catalog");
	const [providerId, setProviderId] = useState<string>();
	const [connectionId, setConnectionId] = useState<string>();
	const [sharedSelection, setSharedSelection] = useState<{ provider: string; model: string }>();
	const [model, setModel] = useState("");
	const [apiKey, setApiKey] = useState("");
	const [search, setSearch] = useState("");
	const [status, setStatus] = useState<{ tone: "idle" | "ok" | "error"; text: string }>({ tone: "idle", text: "尚未验证" });
	const [working, setWorking] = useState(false);
	const [needsVerification, setNeedsVerification] = useState(false);
	const [custom, setCustom] = useState({ providerId: "", displayName: "", baseUrl: "", modelId: "", apiKey: "" });
	const [discovered, setDiscovered] = useState<string[]>([]);
	const [discovering, setDiscovering] = useState(false);
	const discoveryRequest = useRef(0);

	const catalogQuery = useQuery({
		queryKey: modelCatalogKey,
		enabled: open,
		queryFn: async () => {
			const result = await consoleClient.GET("/api/task-drafts/models");
			if (!result.data) throw new Error("模型目录不可用");
			return result.data;
		},
	});
	const connectionsQuery = useQuery({
		queryKey: modelConnectionsKey,
		enabled: open,
		retry: false,
		queryFn: async () => {
			const result = await consoleClient.GET("/api/me/model-connections");
			if (result.data) return result.data;
			if (result.response.status === 503) return null;
			throw new Error("个人模型连接不可用");
		},
	});

	useEffect(() => {
		discoveryRequest.current++;
		setDiscovering(false);
		setModel("");
		setApiKey("");
		setCustom({ providerId: "", displayName: "", baseUrl: "", modelId: "", apiKey: "" });
		setDiscovered([]);
		setNeedsVerification(false);
		if (!open) return;
		setMode("catalog");
		setSearch("");
		setStatus({ tone: "idle", text: "尚未验证" });
		setProviderId(undefined);
		setConnectionId(undefined);
		setSharedSelection(undefined);
		if (choice && "connectionId" in choice) {
			setConnectionId(choice.connectionId);
			setModel(choice.model);
		} else if (choice) {
			setSharedSelection(choice);
		}
	}, [open, choice]);

	const connections = connectionsQuery.data ?? undefined;
	const providers = catalogQuery.data?.providers ?? [];
	const shared = catalogQuery.data?.shared ?? [];
	const supported = useMemo(() => providers.filter((item) => item.supported), [providers]);
	const unsupported = useMemo(() => providers.filter((item) => !item.supported), [providers]);
	const provider = providerId ? providers.find((item) => item.id === providerId) : undefined;
	const selectedConnection = connectionId
		? connections?.connections.find((item) => item.id === connectionId)
		: undefined;
	const keyword = search.trim().toLowerCase();
	const matches = (name: string, models: readonly { id: string; name: string }[]) =>
		!keyword || name.toLowerCase().includes(keyword) ||
		models.some((item) => item.id.toLowerCase().includes(keyword) || item.name.toLowerCase().includes(keyword));
	const defaultsUnavailable = connectionsQuery.data === null;

	function resetDraft() {
		discoveryRequest.current++;
		setDiscovering(false);
		setDiscovered([]);
		setCustom((draft) => ({ ...draft, apiKey: "" }));
		setApiKey("");
		setStatus({ tone: "idle", text: "尚未验证" });
	}

	function pickCatalogProvider(next: ModelCatalogProvider) {
		setMode("catalog");
		setProviderId(next.id);
		setConnectionId(undefined);
		setSharedSelection(undefined);
		setModel(next.models[0]?.id ?? "");
		resetDraft();
	}

	function pickConnection(next: ModelConnection) {
		setMode("catalog");
		setProviderId(undefined);
		setSharedSelection(undefined);
		setConnectionId(next.id);
		setModel(next.models[0]?.id ?? "");
		resetDraft();
	}

	function pickShared(next: { provider: string; model: string }) {
		setMode("catalog");
		setProviderId(undefined);
		setConnectionId(undefined);
		setSharedSelection(next);
		resetDraft();
	}

	async function refreshConnections() {
		await queryClient.invalidateQueries({ queryKey: modelConnectionsKey });
	}

	function requireVerification(statusCode: number, error: unknown) {
		if (statusCode !== 401 || typeof error !== "object" || error === null ||
			!("error" in error) || error.error !== "reauth_required") return false;
		setNeedsVerification(true);
		setStatus({ tone: "error", text: "请先用飞书确认身份，再继续操作。" });
		return true;
	}

	function updateCustom(next: typeof custom) {
		discoveryRequest.current++;
		setDiscovering(false);
		if (next.baseUrl !== custom.baseUrl || next.apiKey !== custom.apiKey) setDiscovered([]);
		setCustom(next);
	}

	async function discover() {
		if (discovering) return;
		if (!custom.baseUrl.trim() || custom.apiKey.trim().length < 8) return;
		const requestId = ++discoveryRequest.current;
		setDiscovering(true);
		setStatus({ tone: "idle", text: "正在获取模型列表…" });
		try {
			const result = await consoleClient.POST("/api/me/model-connections/models", {
				body: {
					baseUrl: custom.baseUrl.trim(),
					protocol: "openai-completions",
					apiKey: custom.apiKey.trim(),
				},
			});
			if (requestId !== discoveryRequest.current) return;
			if (requireVerification(result.response.status, result.error)) return;
			if (!result.data) throw new Error("模型列表不可用");
			setDiscovered(result.data.models);
			setStatus(result.data.models.length
				? { tone: "ok", text: `获取到 ${result.data.models.length} 个模型` }
				: { tone: "error", text: "供应商没有返回模型，可手动填写 Model ID。" });
			if (result.data.models.length && !result.data.models.includes(custom.modelId)) {
				setCustom((current) => ({ ...current, modelId: result.data.models[0] ?? current.modelId }));
			}
		} catch {
			if (requestId === discoveryRequest.current)
				setStatus({ tone: "error", text: "无法获取模型列表，可手动填写 Model ID 后重试。" });
		} finally {
			if (requestId === discoveryRequest.current) setDiscovering(false);
		}
	}

	async function create(input: ModelConnectionInput, modelId: string) {
		if (working) return;
		setWorking(true);
		setStatus({ tone: "idle", text: "正在测试并保存…" });
		try {
			const created = await consoleClient.POST("/api/me/model-connections", { body: input });
			if (requireVerification(created.response.status, created.error)) return;
			if (!created.data) throw new Error("连接未保存");
			setApiKey("");
			setCustom((draft) => ({ ...draft, apiKey: "" }));
			await refreshConnections();
			pickConnection(created.data);
			setStatus({ tone: "ok", text: "连接已保存，可直接在任务中使用" });
			onUse?.({ connectionId: created.data.id, model: modelId });
		} catch {
			setStatus({ tone: "error", text: "连接未通过。请检查密钥、模型与账户额度后重试。" });
		} finally {
			setWorking(false);
		}
	}

	async function test(input: ModelConnectionInput) {
		if (working) return;
		setWorking(true);
		setStatus({ tone: "idle", text: "正在测试…" });
		try {
			const result = await consoleClient.POST("/api/me/model-connections/test", { body: input });
			if (requireVerification(result.response.status, result.error)) return;
			setStatus(result.data?.ok
				? { tone: "ok", text: "测试通过" }
				: { tone: "error", text: "测试未通过。请检查密钥、模型与账户额度。" });
		} catch {
			setStatus({ tone: "error", text: "测试未通过。请检查密钥、模型与账户额度。" });
		} finally {
			setWorking(false);
		}
	}

	async function replaceKey(connection: ModelConnection) {
		if (working || apiKey.trim().length < 8) return;
		setWorking(true);
		setStatus({ tone: "idle", text: "正在测试新密钥…" });
		try {
			const result = await consoleClient.PUT("/api/me/model-connections/{connectionId}", {
				params: { path: { connectionId: connection.id } },
				body: {
					expectedVersion: connection.version,
					models: connection.models,
					credential: { action: "replace", apiKey: apiKey.trim() },
				},
			});
			if (requireVerification(result.response.status, result.error)) return;
			if (!result.data) throw new Error("密钥未更新");
			setApiKey("");
			await refreshConnections();
			setStatus({ tone: "ok", text: "密钥已更新" });
		} catch {
			setStatus({ tone: "error", text: "密钥未通过测试，仍保留原密钥。" });
		} finally {
			setWorking(false);
		}
	}

	async function updateModels(connection: ModelConnection) {
		if (working) return;
		setWorking(true);
		try {
			const result = await consoleClient.PUT("/api/me/model-connections/{connectionId}", {
				params: { path: { connectionId: connection.id } },
				body: { expectedVersion: connection.version, models: [{ id: model }] },
			});
			if (requireVerification(result.response.status, result.error)) return;
			if (!result.data) throw new Error("模型未更新");
			await refreshConnections();
			setStatus({ tone: "ok", text: "模型已更新" });
		} catch {
			setStatus({ tone: "error", text: "模型未更新，请重试。" });
		} finally {
			setWorking(false);
		}
	}

	async function removeCredential(connection: ModelConnection) {
		if (working) return;
		setWorking(true);
		try {
			const result = await consoleClient.DELETE("/api/me/model-connections/{connectionId}/credential", {
				params: { path: { connectionId: connection.id }, query: { expectedVersion: connection.version } },
			});
			if (requireVerification(result.response.status, result.error)) return;
			if (!result.data) throw new Error("密钥未删除");
			await refreshConnections();
			setStatus({ tone: "ok", text: "密钥已删除，连接已停用" });
		} catch {
			setStatus({ tone: "error", text: "密钥未删除，请重试。" });
		} finally {
			setWorking(false);
		}
	}

	async function deleteConnection(connection: ModelConnection) {
		if (working) return;
		setWorking(true);
		try {
			const result = await consoleClient.DELETE("/api/me/model-connections/{connectionId}", {
				params: { path: { connectionId: connection.id }, query: { expectedVersion: connection.version } },
			});
			if (requireVerification(result.response.status, result.error)) return;
			if (!result.data) throw new Error("连接未删除");
			setConnectionId(undefined);
			setModel("");
			await refreshConnections();
			setStatus({ tone: "ok", text: "连接已删除" });
		} catch {
			setStatus({ tone: "error", text: "连接未删除，请重试。" });
		} finally {
			setWorking(false);
		}
	}

	async function setDefault(connection: ModelConnection, modelId: string) {
		if (working) return;
		setWorking(true);
		try {
			const result = await consoleClient.PUT("/api/me/model-preferences", {
				body: { expectedVersion: connections?.preference.version ?? 0, connectionId: connection.id, modelId },
			});
			if (requireVerification(result.response.status, result.error)) return;
			if (!result.data) {
				if (result.response.status === 409) await refreshConnections();
				throw new Error("默认模型未保存");
			}
			const preference = result.data;
			queryClient.setQueryData<ModelConnectionList | null>(modelConnectionsKey, (current) =>
				current ? { ...current, preference } : current);
			setStatus({ tone: "ok", text: "已设为默认模型" });
		} catch {
			setStatus({ tone: "error", text: "默认模型未保存，请重试。" });
		} finally {
			setWorking(false);
		}
	}

	const canCreate = Boolean(
		(mode === "custom"
			? custom.providerId.trim() && custom.baseUrl.trim() && custom.modelId.trim() && custom.apiKey.trim().length >= 8
			: provider?.supported && model && apiKey.trim().length >= 8) && !working,
	);

	function catalogInput(): ModelConnectionInput | undefined {
		if (!provider || !provider.baseUrl || !model) return;
		return {
			providerId: provider.id,
			kind: "catalog",
			catalogId: provider.id,
			displayName: provider.name,
			baseUrl: provider.baseUrl,
			protocol: "openai-completions",
			models: [{ id: model }],
			apiKey: apiKey.trim(),
		};
	}

	function customInput(): ModelConnectionInput | undefined {
		if (!custom.providerId.trim() || !custom.baseUrl.trim() || !custom.modelId.trim()) return;
		return {
			providerId: custom.providerId.trim(),
			kind: "custom",
			...(custom.displayName.trim() ? { displayName: custom.displayName.trim() } : {}),
			baseUrl: custom.baseUrl.trim(),
			protocol: "openai-completions",
			models: [{ id: custom.modelId.trim() }],
			apiKey: custom.apiKey.trim(),
		};
	}

	return (
		<Dialog open={open} onOpenChange={(next) => { if (!working) onOpenChange(next); }}>
			<DialogContent aria-describedby="model-config-summary">
				<DialogHeader>
					<div className="space-y-0.5">
						<DialogTitle>模型配置</DialogTitle>
						<DialogDescription id="model-config-summary">
							连接供应商或自定义 API，用于任务草稿的辅助填写。密钥加密保存，仅本人可用。
						</DialogDescription>
					</div>
					<DialogCloseButton />
				</DialogHeader>

				<div className="grid min-h-0 flex-1 sm:grid-cols-[13.5rem_1fr]">
					<aside className="flex min-h-0 flex-col gap-2 border-b p-3 sm:border-r sm:border-b-0">
						<Input value={search} onChange={(event) => setSearch(event.target.value)}
							placeholder="搜索供应商或模型" aria-label="搜索供应商或模型" />
						<div className="min-h-0 flex-1 space-y-3 overflow-y-auto pr-1">
							{catalogQuery.isPending || connectionsQuery.isPending ? (
								<p role="status" className="text-xs text-muted-foreground">正在读取模型目录…</p>
							) : null}
							{catalogQuery.isError ? <p role="alert" className="text-xs text-destructive">模型目录暂时不可用，请稍后重试。</p> : null}
							{connectionsQuery.isError ? <p role="alert" className="text-xs text-destructive">个人连接暂时不可用，请稍后重试。</p> : null}

							{connections?.connections.length ? (
								<ProviderGroup title="我的连接">
									{connections.connections.map((item) => (
										<ProviderButton key={item.id}
											title={item.displayName}
											subtitle={item.hasCredential ? `${item.models[0]?.id ?? ""} · 已保存` : "已停用"}
											active={connectionId === item.id}
											onClick={() => pickConnection(item)} />
									))}
								</ProviderGroup>
							) : null}

							{shared.length ? (
								<ProviderGroup title="部署提供">
									{shared.map((item) => (
										<ProviderButton key={"shared:" + item.provider + ":" + item.model}
											title={item.label} subtitle="使用部署密钥"
											active={sharedSelection?.provider === item.provider && sharedSelection.model === item.model}
											onClick={() => pickShared({ provider: item.provider, model: item.model })} />
									))}
								</ProviderGroup>
							) : null}

							<ProviderGroup title="可直连供应商">
								{supported.filter((item) => matches(item.name, item.models)).map((item) => (
									<ProviderButton key={item.id} title={item.name}
										subtitle={item.models.length + " 个模型"} active={providerId === item.id}
										onClick={() => pickCatalogProvider(item)} />
								))}
							</ProviderGroup>

							{unsupported.length ? (
								<ProviderGroup title="其他供应商">
									{unsupported.filter((item) => matches(item.name, [])).map((item) => (
										<ProviderButton key={item.id} title={item.name} subtitle="暂不支持" muted
											active={providerId === item.id} onClick={() => pickCatalogProvider(item)} />
									))}
								</ProviderGroup>
							) : null}
						</div>
						<Button type="button" variant="outline" size="sm" className="justify-center"
							onClick={() => { setMode("custom"); setProviderId(undefined); setConnectionId(undefined); resetDraft(); }}>
							＋ 自定义服务商
						</Button>
						<p className="text-[11px] leading-tight text-muted-foreground">
							{defaultsUnavailable
								? "部署者尚未配置主密钥，个人连接暂不可保存；可使用“部署提供”的模型。"
								: "密钥在服务端加密保存，登出或重启后仍可用；这是服务端加密，不是端到端加密。"}
						</p>
					</aside>

					<section className="flex min-h-0 flex-col">
						<div className="flex gap-1 border-b px-4 py-2">
							<TabButton active={mode === "catalog"} onClick={() => setMode("catalog")}>第三方供应商</TabButton>
							<TabButton active={mode === "custom"} onClick={() => setMode("custom")}>自定义 API</TabButton>
						</div>

						<div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
							{mode === "custom" ? (
								<CustomForm custom={custom} working={working} discovered={discovered} discovering={discovering}
									onChange={updateCustom} onDiscover={() => void discover()} onManual={() => setDiscovered([])} />
							) : selectedConnection ? (
								<ExistingConnectionPanel
									connection={selectedConnection} model={model} connections={connections} catalog={catalogQuery.data}
									apiKey={apiKey} working={working} defaultsUnavailable={defaultsUnavailable}
									onModel={setModel} onApiKey={setApiKey}
										onUse={() => void setDefault(selectedConnection, model)}
									onUpdateModels={() => void updateModels(selectedConnection)}
									onReplaceKey={() => void replaceKey(selectedConnection)}
									onRemoveCredential={() => void removeCredential(selectedConnection)}
									onDelete={() => void deleteConnection(selectedConnection)} />
							) : sharedSelection ? (
								<div className="space-y-2 text-sm">
									<p className="font-medium">
										{shared.find((item) => item.provider === sharedSelection.provider && item.model === sharedSelection.model)?.label ?? sharedSelection.model}
									</p>
									<p className="text-muted-foreground">该模型由部署者配置密钥，不消耗你的个人额度。选择后仅用于本次任务。</p>
								</div>
							) : provider ? (
								provider.supported ? (
									<div className="space-y-3">
										<Field label="供应商名称">
											<Input value={provider.name} readOnly disabled />
										</Field>
										<Field label="API Key" hint="只写字段，保存后不再显示。">
											<Input type="password" autoComplete="new-password" maxLength={512} value={apiKey} disabled={working}
												placeholder={keyPlaceholder} onChange={(event) => setApiKey(event.target.value)} />
										</Field>
										<Field label="API Base URL" hint="由供应商目录提供，普通用户无需填写。">
											<Input value={provider.baseUrl ?? ""} readOnly disabled />
										</Field>
										<Field label="Model ID" hint="每个连接当前保存一个模型；之后可在这里更换。">
											<select value={model} onChange={(event) => setModel(event.target.value)} disabled={working}
												className="h-8 w-full rounded-lg border bg-transparent px-2 text-sm">
												{provider.models.map((item) => (
													<option key={item.id} value={item.id}>{item.name + "（" + item.id + "）"}</option>
												))}
											</select>
										</Field>
										<AdvancedDetails baseUrl={provider.baseUrl ?? ""} />
									</div>
								) : (
									<div className="space-y-2 text-sm">
										<p className="font-medium">{provider.name}</p>
										<p role="note" className="rounded-lg border border-dashed px-3 py-2 text-muted-foreground">
											{provider.reason ?? "该供应商暂不支持个人 API Key 直连。"}
										</p>
										<p className="text-xs text-muted-foreground">目录来自锁定的 pi-ai 版本，接入范围按真实协议能力列出。</p>
									</div>
								)
							) : (
								<p className="text-sm text-muted-foreground">从左侧选择供应商或已有连接，也可以添加自定义服务商。</p>
							)}
						</div>

						<footer className="flex flex-wrap items-center justify-between gap-3 border-t px-4 py-3">
							<p role="status" className={status.tone === "error" ? "text-xs text-destructive" : "text-xs text-muted-foreground"}>
								{status.text}
							</p>
							{needsVerification ? (
								<a className="text-sm underline" href={`/auth/feishu/login?reauth=1&returnTo=${encodeURIComponent(safeReturnTo(window.location.pathname + window.location.search + window.location.hash))}`}>
									用飞书确认身份
								</a>
							) : null}
							{mode === "custom" ? (
								<div className="flex gap-2">
									<Button type="button" variant="outline" disabled={!customInput() || working || defaultsUnavailable}
										onClick={() => { const input = customInput(); if (input) void test(input); }}>
										测试连接
									</Button>
									<Button type="button" disabled={!canCreate || defaultsUnavailable}
										onClick={() => { const input = customInput(); if (input) void create(input, input.models[0]?.id ?? ""); }}>
										{onUse ? "保存并使用" : "测试并保存"}
									</Button>
								</div>
							) : sharedSelection && onUse ? (
								<Button type="button" onClick={() => {
									onUse?.(sharedSelection);
									onOpenChange(false);
								}}>使用此模型</Button>
							) : selectedConnection && onUse ? (
								<Button type="button" disabled={working || !selectedConnection.hasCredential || selectedConnection.status !== "active" ||
									!selectedConnection.models.some((item) => item.id === model)}
									onClick={() => onUse({ connectionId: selectedConnection.id, model })}>
									用于本次任务
								</Button>
							) : provider?.supported && !defaultsUnavailable ? (
								<div className="flex gap-2">
									<Button type="button" variant="outline" disabled={!catalogInput() || working}
										onClick={() => { const input = catalogInput(); if (input) void test(input); }}>
										测试连接
									</Button>
									<Button type="button" disabled={!canCreate}
										onClick={() => { const input = catalogInput(); if (input) void create(input, model); }}>
										{onUse ? "保存并使用" : "测试并保存"}
									</Button>
								</div>
							) : null}
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

function AdvancedDetails({ baseUrl }: { baseUrl: string }) {
	return (
		<details className="rounded-lg border px-3 py-2 text-sm">
			<summary className="cursor-pointer text-xs font-medium">高级选项</summary>
			<dl className="mt-2 space-y-1 text-xs text-muted-foreground">
				<div className="flex justify-between gap-4"><dt>协议</dt><dd>{protocolHint}</dd></div>
				<div className="flex justify-between gap-4"><dt>请求地址</dt><dd className="truncate">{baseUrl + "/chat/completions"}</dd></div>
				<div className="flex justify-between gap-4"><dt>凭据</dt><dd>服务端加密，仅本人可用</dd></div>
			</dl>
		</details>
	);
}

function ExistingConnectionPanel({ connection, model, connections, catalog, apiKey, working, defaultsUnavailable, onModel, onApiKey, onUse, onUpdateModels, onReplaceKey, onRemoveCredential, onDelete }: {
	connection: ModelConnection;
	model: string;
	connections: ModelConnectionList | undefined;
	catalog: ModelCatalog | undefined;
	apiKey: string;
	working: boolean;
	defaultsUnavailable: boolean;
	onModel: (value: string) => void;
	onApiKey: (value: string) => void;
	onUse: () => void;
	onUpdateModels: () => void;
	onReplaceKey: () => void;
	onRemoveCredential: () => void;
	onDelete: () => void;
}) {
	const catalogModels = catalog?.providers.find((item) => item.id === connection.catalogId)?.models ?? [];
	const isDefault = connections?.preference.connectionId === connection.id &&
		connections.preference.modelId === model;
	const hasKey = connection.hasCredential && connection.status === "active";
	return (
		<div className="space-y-3">
			<div className="flex flex-wrap items-start justify-between gap-2">
				<div className="space-y-0.5">
					<p className="font-medium">{connection.displayName}</p>
					<p className="text-xs text-muted-foreground">
						{connection.kind === "catalog" ? "目录供应商" : "自定义 API"} · {connection.baseUrl}
					</p>
				</div>
				<span className="rounded-full border px-2 py-0.5 text-[11px]">
					{hasKey ? (connection.verifiedVersion === connection.version ? "已验证" : "已保存") : "已停用"}
				</span>
			</div>

			<Field label="Model ID" hint={catalogModels.length ? "来自目录，选中后可更新到该连接。" : "自定义连接的模型 ID。"}>
				{catalogModels.length ? (
					<select value={model} onChange={(event) => onModel(event.target.value)} disabled={working}
						className="h-8 w-full rounded-lg border bg-transparent px-2 text-sm">
						{catalogModels.map((item) => (
							<option key={item.id} value={item.id}>{item.name + "（" + item.id + "）"}</option>
						))}
					</select>
				) : (
					<Input value={model} readOnly disabled />
				)}
			</Field>
			<div className="flex flex-wrap gap-2">
				<Button type="button" size="sm" variant="outline" disabled={working || isDefault || !hasKey ||
					!connection.models.some((item) => item.id === model)} onClick={onUse}>
					{isDefault ? "当前默认" : "设为默认"}
				</Button>
				<Button type="button" size="sm" variant="outline" disabled={working || !hasKey ||
					connection.models.some((item) => item.id === model)}
					onClick={onUpdateModels}>
					更新模型
				</Button>
			</div>

			<Field label="API Key" hint={hasKey ? "已保存的密钥不会回显；更换需重新测试。" : "该连接没有密钥，填写后会重新启用。"}>
				<div className="flex gap-2">
					<Input type="password" autoComplete="new-password" maxLength={512} value={apiKey} disabled={working}
						placeholder={hasKey ? "已保存，如需更换请重新填写" : keyPlaceholder}
						onChange={(event) => onApiKey(event.target.value)} />
					<Button type="button" size="sm" variant="outline" disabled={working || apiKey.trim().length < 8 || defaultsUnavailable}
						onClick={onReplaceKey}>
						更换密钥
					</Button>
				</div>
			</Field>

			{defaultsUnavailable ? (
				<p role="note" className="text-xs text-muted-foreground">部署者未配置主密钥，无法保存或更换密钥。</p>
			) : null}

			<AdvancedDetails baseUrl={connection.baseUrl} />

			<div className="flex flex-wrap gap-2 border-t pt-3">
				<Button type="button" size="sm" variant="outline" disabled={working || !hasKey || defaultsUnavailable} onClick={onRemoveCredential}>
					删除密钥
				</Button>
				<Button type="button" size="sm" variant="destructive" disabled={working || defaultsUnavailable} onClick={onDelete}>
					删除连接
				</Button>
			</div>
		</div>
	);
}

function CustomForm({ custom, working, discovered, discovering, onChange, onDiscover, onManual }: {
	custom: { providerId: string; displayName: string; baseUrl: string; modelId: string; apiKey: string };
	working: boolean;
	discovered: string[];
	discovering: boolean;
	onChange: (value: { providerId: string; displayName: string; baseUrl: string; modelId: string; apiKey: string }) => void;
	onDiscover: () => void;
	onManual: () => void;
}) {
	return (
		<div className="space-y-3">
			<p role="note" className="rounded-lg border border-dashed px-3 py-2 text-xs text-muted-foreground">
				自定义 API 与目录供应商走同一套受控出网：仅 HTTPS 公网地址、绑定 DNS 结果、禁止重定向。供应商需支持 SSE 与 JSON 输出。
			</p>
			<Field label="Provider ID" hint="稳定标识，创建后不可改；小写字母开头，可含数字与连字符。">
				<Input value={custom.providerId} maxLength={48} disabled={working} placeholder="例如：company-gateway"
					onChange={(event) => onChange({ ...custom, providerId: event.target.value })} />
			</Field>
			<Field label="显示名称">
				<Input value={custom.displayName} maxLength={80} disabled={working} placeholder="例如：公司内部网关"
					onChange={(event) => onChange({ ...custom, displayName: event.target.value })} />
			</Field>
			<Field label="API Base URL" hint="不是完整的聊天请求地址；会请求 {Base URL}/chat/completions。">
				<Input value={custom.baseUrl} maxLength={512} disabled={working} placeholder="https://api.example.com/v1"
					onChange={(event) => onChange({ ...custom, baseUrl: event.target.value })} />
			</Field>
			<Field label="Model ID" hint={discovered.length ? "来自供应商列表；也可以改为手动输入。" : "可手动填写，或先用上面的地址与密钥获取列表。"}>
				<div className="space-y-2">
					{discovered.length ? (
						<>
							<select value={custom.modelId} onChange={(event) => onChange({ ...custom, modelId: event.target.value })} disabled={working}
								className="h-8 w-full rounded-lg border bg-transparent px-2 text-sm">
								{discovered.map((id) => <option key={id} value={id}>{id}</option>)}
							</select>
							<Button type="button" size="sm" variant="ghost" className="h-6 px-2 text-xs" onClick={onManual}>
								改为手动输入
							</Button>
						</>
					) : (
						<Input value={custom.modelId} maxLength={160} disabled={working} placeholder="例如：mimo-v2-flash"
							onChange={(event) => onChange({ ...custom, modelId: event.target.value })} />
					)}
					<Button type="button" size="sm" variant="outline" disabled={working || discovering || !custom.baseUrl.trim() || custom.apiKey.trim().length < 8}
						onClick={onDiscover}>
						{discovering ? "正在获取…" : "获取模型列表"}
					</Button>
				</div>
			</Field>
			<Field label="API Key" hint="只写字段，保存后不再显示。">
				<Input type="password" autoComplete="new-password" maxLength={512} value={custom.apiKey} disabled={working}
					placeholder={keyPlaceholder} onChange={(event) => onChange({ ...custom, apiKey: event.target.value })} />
			</Field>
		</div>
	);
}
