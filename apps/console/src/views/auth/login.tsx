import { useState } from "react";
import { useLocation } from "react-router";
import { safeReturnTo } from "./return-to";

const messages: Record<string, string> = {
	authorization: "授权未完成或已过期，请重新登录。",
	identity: "无法验证飞书企业身份，请确认账号有此应用访问权限。",
};

export default function LoginPage() {
	const location = useLocation();
	const state = location.state as { returnTo?: unknown } | null;
	const query = new URLSearchParams(location.search);
	const returnTo = safeReturnTo(
		typeof state?.returnTo === "string" ? state.returnTo : query.get("returnTo"),
	);
	const error = query.get("error") ?? "";
	const [rememberMe, setRememberMe] = useState(false);
	const loginUrl = `/auth/feishu/login?returnTo=${encodeURIComponent(returnTo)}${rememberMe ? "&rememberMe=1" : ""}`;
	return (
		<main className="min-h-screen flex items-center justify-center p-6 bg-muted/40">
			<section className="w-full max-w-sm rounded-xl border bg-background p-8 shadow-sm space-y-5">
				<div className="space-y-2">
					<h1 className="text-xl font-semibold">登录 AdPulse</h1>
					<p className="text-sm text-muted-foreground">
						使用已获此飞书应用授权的企业账号继续。
					</p>
				</div>
				{messages[error] && (
					<p role="alert" className="text-sm text-destructive">
						{messages[error]}
					</p>
				)}
				<label className="flex items-center gap-2 text-sm text-muted-foreground">
					<input
						type="checkbox"
						checked={rememberMe}
						onChange={(event) => setRememberMe(event.target.checked)}
					/>
					记住我（仅限私人可信设备；公用设备请勿勾选）
				</label>
				<a
					href={loginUrl}
					className="inline-flex h-9 w-full items-center justify-center rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground hover:opacity-90"
				>
					使用飞书企业账号登录
				</a>
			</section>
		</main>
	);
}