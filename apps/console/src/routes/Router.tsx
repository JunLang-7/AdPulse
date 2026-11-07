import { useEffect, useState, type ReactNode } from "react";
import { Link, Navigate, Outlet, useLocation } from "react-router";
import { consoleClient } from "../adpulse-client";
import FullLayout from "../layouts/full/FullLayout";
import LoginPage from "../views/auth/login";
import SessionDetailPage from "../views/adpulse/session-detail";
import SessionsPage from "../views/adpulse/sessions";
import TaskEditorPage from "../views/adpulse/tasks/editor";
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
	const [state, setState] = useState<"loading" | "ready" | "unauthenticated" | "error">("loading");
	useEffect(() => {
		let active = true;
		void consoleClient
			.GET("/api/me")
			.then(({ response, error }) => {
				if (!active) return;
				if (!error) setState("ready");
				else if (response.status === 401) setState("unauthenticated");
				else setState("error");
			})
			.catch(() => {
				if (active) setState("error");
			});
		return () => {
			active = false;
		};
	}, []);
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
	return <Outlet />;
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
				],
			},
		],
	},
	{ path: "/login", element: <LoginPage /> },
];

export default Router;
