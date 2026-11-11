import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { consoleClient } from "../../../../adpulse-client";
import { Badge } from "../../../../components/ui/badge";
import {
	Card,
	CardContent,
	CardHeader,
	CardTitle,
} from "../../../../components/ui/card";
import {
	describeNotificationStatus,
	type NotificationAction,
	type NotificationStatusLike,
} from "./notification-view";

const errorText = (status: number, error: unknown): string => {
	switch (status) {
		case 403:
			return "当前登录身份没有确认这个地址的权限，请重新登录后再试。";
		case 404:
			return "还没有可用的单聊地址，请先确认地址。";
		case 409:
			return "状态已被更新（可能在其他标签页操作过），请刷新后重试。";
		case 400:
			return "请求参数不合法，请刷新页面后重试。";
		default:
			return `操作失败：${String(error)}`;
	}
};

export default function NotificationSettingsPage() {
	const queryClient = useQueryClient();
	const [notice, setNotice] = useState<string | null>(null);

	const { data, isLoading, error } = useQuery({
		queryKey: ["notification-status"],
		queryFn: async () => {
			const result = await consoleClient.GET("/api/me/notification-status");
			if (!result.data) throw new Error(JSON.stringify(result.error));
			return result.data as unknown as NotificationStatusLike;
		},
	});

	const verify = useMutation({
		mutationFn: async () => {
			const result = await consoleClient.PUT("/api/me/notification-destination", {
				body: undefined,
			});
			if (result.error)
				throw Object.assign(new Error("verify failed"), {
					status: result.response.status,
					detail: result.error,
				});
			return result.data;
		},
		onSuccess: () => {
			setNotice("已确认单聊地址。");
			return queryClient.invalidateQueries({ queryKey: ["notification-status"] });
		},
	});

	const changeConsent = useMutation({
		mutationFn: async ({
			action,
			expectedVersion,
		}: {
			action: "grant" | "revoke";
			expectedVersion: number;
		}) => {
			const result = await consoleClient.POST("/api/me/notification-consent", {
				body: { action, expectedVersion },
			});
			if (result.error)
				throw Object.assign(new Error("consent failed"), {
					status: result.response.status,
					detail: result.error,
				});
			return result.data;
		},
		onSuccess: (_data, variables) => {
			setNotice(
				variables.action === "grant"
					? "已开启主动提醒。撤销不会影响登录，随时可再次关闭。"
					: "已撤销主动提醒。这不影响你的登录状态。",
			);
			return queryClient.invalidateQueries({ queryKey: ["notification-status"] });
		},
	});

	const mutationError = verify.error ?? changeConsent.error;
	type MutationFailure = Error & { status?: number; detail?: unknown };
	const failure = (mutationError as MutationFailure | null) ?? null;

	const run = async (action: NotificationAction) => {
		setNotice(null);
		if (action.kind === "verify") return verify.mutateAsync();
		return changeConsent.mutateAsync({
			action: action.kind,
			expectedVersion: action.expectedVersion ?? 0,
		});
	};

	if (isLoading) return <div className="p-6">正在读取通知设置…</div>;
	if (error || !data)
		return <div className="p-6 text-red-600">读取通知设置失败：{String(error)}</div>;

	const view = describeNotificationStatus(data);
	const busy = verify.isPending || changeConsent.isPending;

	return (
		<div className="p-6 space-y-4">
			<div>
				<h1 className="text-2xl font-bold">通知设置</h1>
				<p className="text-sm text-muted-foreground">
					控制机器人往哪个单聊发提醒，以及是否允许主动发送。登录状态与提醒授权相互独立。
				</p>
			</div>

			<Card className="max-w-2xl">
				<CardHeader>
					<div className="flex items-start justify-between gap-3">
						<CardTitle>{view.title}</CardTitle>
						<Badge variant="outline">
							{data.canSendProactive ? "可发送" : "不会发送"}
						</Badge>
					</div>
				</CardHeader>
				<CardContent className="space-y-4">
					<p className="text-sm text-muted-foreground">{view.detail}</p>

					<dl className="grid gap-2 text-sm">
						<div className="flex items-baseline justify-between gap-3">
							<dt className="text-muted-foreground">单聊地址</dt>
							<dd>
								{view.destination
									? `${view.destination.platform} · ${view.destination.maskedId}`
									: "未确认"}
							</dd>
						</div>
						<div className="flex items-baseline justify-between gap-3">
							<dt className="text-muted-foreground">主动提醒</dt>
							<dd>
								{data.consent === null
									? "尚未开启"
									: data.consent.status === "active"
										? "已开启"
										: "已撤销"}
							</dd>
						</div>
					</dl>

					{view.warning ? (
						<p role="alert" className="text-sm text-amber-600">
							{view.warning}
						</p>
					) : null}
					{notice ? (
						<p role="status" className="text-sm text-emerald-700">
							{notice}
						</p>
					) : null}
					{failure ? (
						<p role="alert" className="text-sm text-red-600">
							{errorText(failure.status ?? 0, failure.detail ?? failure.message)}
						</p>
					) : null}

					<div className="flex flex-wrap gap-2">
						{view.actions.map((action) => (
							<button
								key={action.kind}
								type="button"
								disabled={busy}
								onClick={() => void run(action)}
								className={
									action.kind === "revoke"
										? "rounded-md border border-red-300 px-3 py-2 text-sm text-red-600 disabled:opacity-50"
										: "rounded-md bg-primary px-3 py-2 text-sm text-primary-foreground disabled:opacity-50"
								}
							>
								{busy ? "处理中…" : action.label}
							</button>
						))}
					</div>

					<p className="text-xs text-muted-foreground">
						提醒只发到你本人单聊，不发送群消息；关闭提醒不会退出登录，也不会删除已确认的地址。
					</p>
				</CardContent>
			</Card>
		</div>
	);
}
