import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { consoleClient, type components } from "../../../adpulse-client";
import { Button } from "../../../components/ui/button";
import { Input } from "../../../components/ui/input";
import {
	Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger,
} from "../../../components/ui/sheet";

export type TaskDraftProvider = components["schemas"]["TaskDraftProvider"];
const catalogKey = ["task-draft-models"] as const;
const statuses = { configured: "服务端已配置", connected: "临时连接已验证", unconfigured: "未连接" };

export function TaskModelSettings({ selected, onSelect, disabled }: {
	selected: TaskDraftProvider | undefined;
	onSelect: (provider: TaskDraftProvider | undefined) => void;
	disabled: boolean;
}) {
	const [open, setOpen] = useState(false);
	const [editing, setEditing] = useState<TaskDraftProvider>();
	const [secret, setSecret] = useState("");
	const [working, setWorking] = useState(false);
	const [message, setMessage] = useState("");
	const queryClient = useQueryClient();
	const { data, isError, isPending, refetch } = useQuery({
		queryKey: catalogKey,
		enabled: open,
		queryFn: async () => {
			const response = await consoleClient.GET("/api/task-drafts/models");
			if (!response.data) throw new Error("模型列表不可用");
			return response.data;
		},
	});
	const active = selected ?? data?.defaultProvider;

	async function changeConnection(provider: TaskDraftProvider, remove = false) {
		const apiKey = secret.trim();
		if (working || (!remove && !apiKey)) return;
		setSecret("");
		setMessage("");
		setWorking(true);
		try {
			const response = remove
				? await consoleClient.DELETE("/api/task-drafts/models", { params: { query: { provider } } })
				: await consoleClient.PUT("/api/task-drafts/models", { body: { provider, apiKey } });
			if (!response.data) throw new Error("连接不可用");
			queryClient.setQueryData(catalogKey, response.data);
			if (!remove) onSelect(provider);
			else if (selected === provider) onSelect(undefined);
			setEditing(undefined);
			setMessage(remove ? "临时连接已断开。" : "连接验证通过，已选用于本次任务。");
		} catch {
			setMessage(remove ? "暂时无法断开，请稍后重试。" : "连接未通过。请检查密钥及服务是否可用，再试一次。");
		} finally {
			setWorking(false);
		}
	}

	return (
		<Sheet open={open} onOpenChange={(next) => {
			if (working && !next) return;
			setOpen(next);
			if (!next) {
				setEditing(undefined);
				setSecret("");
				setMessage("");
			}
		}}>
			<SheetTrigger render={<Button type="button" variant="outline" size="sm" disabled={disabled} />}>模型设置</SheetTrigger>
			<SheetContent className="w-full overflow-y-auto sm:max-w-md">
				<SheetHeader>
					<SheetTitle>模型设置</SheetTitle>
					<SheetDescription>按提供方选择模型。选择适用于本次任务的后续辅助填写和阶段整理。</SheetDescription>
				</SheetHeader>
				<div className="space-y-3 px-4 pb-5">
					{isPending ? <p role="status">正在读取模型列表…</p> : null}
					{isError ? <Button type="button" variant="outline" onClick={() => void refetch()}>重新读取模型列表</Button> : null}
					{data?.models.map(({ id, label, model, status }) => (
						<section key={id} className="space-y-3 rounded-lg border p-3" aria-label={label}>
							<div className="flex flex-wrap items-start justify-between gap-2">
								<div className="min-w-0 space-y-1">
									<h3 className="font-semibold">{label}</h3>
									<p className="break-all text-sm">{model}</p>
									<p className="text-xs text-muted-foreground">{statuses[status]}{data.defaultProvider === id ? " · 部署默认" : ""}</p>
								</div>
								<Button type="button" size="sm" variant={active === id ? "secondary" : "outline"}
									disabled={status === "unconfigured" || working} aria-pressed={active === id}
									onClick={() => { onSelect(id); setSecret(""); setEditing(undefined); setMessage(""); setOpen(false); }}>
									{active === id && status !== "unconfigured" ? "当前选择" : "选择此模型"}
								</Button>
							</div>
							{data.canConnect ? (
								<div className="space-y-2">
									{editing === id ? (
										<>
											<label className="block space-y-1">
												<span>API 密钥</span>
												<Input type="password" autoComplete="new-password" maxLength={512} disabled={working}
													value={secret} onChange={(event) => setSecret(event.target.value)} />
											</label>
											<Button type="button" size="sm" disabled={working || secret.trim().length < 8}
												onClick={() => void changeConnection(id)}>{working ? "正在验证…" : "测试并连接"}</Button>
										</>
									) : (
										<div className="flex flex-wrap gap-2">
											<Button type="button" size="sm" variant="ghost" disabled={working} onClick={() => {
												setEditing(id); setSecret(""); setMessage("");
											}}>{status === "connected" ? "更换临时密钥" : "连接 API 密钥"}</Button>
											{status === "connected" ? <Button type="button" size="sm" variant="ghost" disabled={working}
												onClick={() => void changeConnection(id, true)}>断开连接</Button> : null}
										</div>
									)}
								</div>
							) : null}
						</section>
					))}
					{data && !data.models.length ? <p role="status">暂无可选模型。</p> : null}
					{data?.canConnect ? (
						<p className="text-xs text-muted-foreground">测试只发送一条固定测试文本。临时密钥在服务端内存最多保留 8 小时，服务重启后需重新连接。</p>
					) : data ? <p className="text-xs text-muted-foreground">连接由部署者管理。需要新增服务时，请联系部署者配置。</p> : null}
					{message ? <p role="status">{message}</p> : null}
				</div>
			</SheetContent>
		</Sheet>
	);
}
