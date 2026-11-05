import type { ReactNode } from "react";
import { Link } from "react-router";
import FullLayout from "../layouts/full/FullLayout";
import SessionDetailPage from "../views/adpulse/session-detail";
import SessionsPage from "../views/adpulse/sessions";

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

const Router = [
	{
		path: "/",
		element: <FullLayout />,
		errorElement: <RouteError error="未知错误" />,
		children: [
			{ path: "/", element: <SessionsPage /> },
			{ path: "/sessions", element: <SessionsPage /> },
			{ path: "/sessions/:sessionId", element: <SessionDetailPage /> },
		],
	},
];

export default Router;
