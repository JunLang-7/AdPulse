import { useQueryClient } from "@tanstack/react-query";
import { flushSync } from "react-dom";
import { useEffect, useState, type ReactNode } from "react";
import { Link, Navigate, Outlet, useLocation } from "react-router";
import { consoleClient } from "../adpulse-client";
import FullLayout from "../layouts/full/FullLayout";
import LoginPage from "../views/auth/login";
import { announceSessionIdentity, watchSessionIdentity } from "../views/auth/session-sync";
import SessionDetailPage from "../views/adpulse/session-detail";
import SessionsPage from "../views/adpulse/sessions";
import TaskEditorPage from "../views/adpulse/tasks/editor";
import TaskReviewPage from "../views/adpulse/tasks/review";
import NotificationSettingsPage from "../views/adpulse/settings/notifications";
import SubscriptionSettingsPage from "../views/adpulse/settings/subscriptions";
import TasksPage from "../views/adpulse/tasks";

function RouteError({ error }: { error: unknown }): ReactNode {
	return (
		<div className="p-6 space-y-2">
			<h1 className="text-lg font-semibold text-red-600">页面加载失败</h1>
			<pre className="text-xs whitespace-pre-wrap">{String(error)}</pre>
			<Link className="text-sm underline" to="/">
				返回会话列表
			</Link>
		</div>
	);
}

function RequireSession() {
	const location = useLocation();
	const queryClient = useQueryClient();
	const [userId, setUserId] = useState<string>();
	const [state, setState] = useState<"loading" | "ready" | "unauthenticated" | "error">("loading");
	useEffect(() => {
		let active = true;
		let currentUserId: string | undefined;
		let reloading = false;
		let verifying = false;
		const invalidate = () => {
			if (!active || reloading) return;
			reloading = true;
			active = false;
			// Unmount forms and private content before clearing queries or reloading.
			flushSync(() => setState("loading"));
			void queryClient.cancelQueries();
			queryClient.clear();
			window.location.reload();
		};
		const stopWatching = watchSessionIdentity(() => currentUserId, invalidate);
		const verify = async (initial = false) => {
			if (verifying) return;
			verifying = true;
			try {
				const { data, response, error } = await consoleClient.GET("/api/me");
				if (!active) return;
				if (data && !error) {
					if (!initial && data.userId !== currentUserId) return invalidate();
					currentUserId = data.userId;
					setUserId(data.userId);
					announceSessionIdentity(data.userId);
					setState("ready");
				} else if (response.status === 401) {
					if (!initial) return invalidate();
					queryClient.clear();
					announceSessionIdentity(null);
					setState("unauthenticated");
				} else setState("error");
			} catch {
				if (active) setState("error");
			} finally {
				verifying = false;
			}
		};
		const focus = () => { void verify(); };
		const restored = (event: PageTransitionEvent) => { if (event.persisted) invalidate(); };
		let lastActivityReport = 0;
		const reportActivity = () => {
			const now = Date.now();
			if (now - lastActivityReport < 60_000) return;
			lastActivityReport = now;
			void consoleClient
				.POST("/api/session/activity")
				.then(({ response }) => {
					if (response.status === 401) invalidate();
				})
				.catch(() => {});
		};
		const activityEvents = ["click", "keydown", "input", "pointerdown"] as const;
		for (const eventName of activityEvents)
			window.addEventListener(eventName, reportActivity, { passive: true, capture: true });
		const visibility = () => {
			if (document.visibilityState === "visible") reportActivity();
		};
		document.addEventListener("visibilitychange", visibility);
		window.addEventListener("focus", focus);
		window.addEventListener("pageshow", restored);
		void verify(true);
		return () => {
			active = false;
			stopWatching();
			for (const eventName of activityEvents)
				window.removeEventListener(eventName, reportActivity, true);
			document.removeEventListener("visibilitychange", visibility);
			window.removeEventListener("focus", focus);
			window.removeEventListener("pageshow", restored);
		};
	}, [queryClient]);
	if (state === "loading") return <div className="p-6">正在验证登录…</div>;
	if (state === "unauthenticated")
		return (
			<Navigate
				to="/login"
				replace
				state={{ returnTo: `${location.pathname}${location.search}${location.hash}` }}
			/>
		);
	if (state === "error")
		return <div className="p-6">无法连接认证服务，请稍后刷新重试。</div>;
	return <Outlet key={userId} />;
}

const Router = [
	{
		path: "/",
		element: <RequireSession />,
		errorElement: <RouteError error="未知错误" />,
		children: [
			{
				element: <FullLayout />,
				children: [
					{ path: "/", element: <SessionsPage /> },
					{ path: "/sessions", element: <SessionsPage /> },
					{ path: "/sessions/:sessionId", element: <SessionDetailPage /> },
					{ path: "/tasks", element: <TasksPage /> },
					{ path: "/tasks/:taskId", element: <TaskEditorPage /> },
					{ path: "/tasks/:taskId/review", element: <TaskReviewPage /> },
					{ path: "/settings/notifications", element: <NotificationSettingsPage /> },
					{ path: "/settings/subscriptions", element: <SubscriptionSettingsPage /> },
				],
			},
		],
	},
	{ path: "/login", element: <LoginPage /> },
];

export default Router;
