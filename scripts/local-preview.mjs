#!/usr/bin/env node
// 本地预览（仅开发用，不是真机验收）：
// - 真实 createApi 路由 + 真实 OAuth 流程，但 provider 是假的（固定身份，零网络）；
// - 内存存储（退出即丢），不碰生产数据、不发 IM；
// - AI 整理端点用「固定样例输出」代替模型，方便在没有 DEEPSEEK_API_KEY 时试 UI 手感；
//   输出严格走与真实模型相同的 parseEventDraft 校验，因此拦截能力也是真实的。
//
// 启动：
//   bun run build
//   node scripts/local-preview.mjs
// 然后打开 http://localhost:5173 → 点「使用飞书登录」→ 自动完成假登录 → 录入事件试手感。
//
// 绝不可用于生产：此脚本不读取任何真实凭据，也不监听公网。
import { createHash } from "node:crypto";
import { createApi } from "../apps/api/dist/server.js";
import { MemoryStorage } from "../packages/storage/dist/index.js";
import { compose } from "../packages/runtime/dist/index.js";

const PORT = Number(process.env.PORT ?? 3000);
// Vite dev server 在 5173，把 /api、/auth、/webhooks 代理到本端口；
// OAuth callback 指向 PUBLIC_ORIGIN（5173），再由代理转发到这里。
const PUBLIC_ORIGIN = process.env.PUBLIC_ORIGIN ?? "http://localhost:5173";
const storage = new MemoryStorage();
const runtime = compose(storage, []);

// 用固定样例输出顶替模型：与真实模型走完全相同的解析/校验路径。
runtime.taskDraftModels = {
  completeJson: async (_ownerId, systemPrompt, brief) => {
    console.log("[preview-model] system prompt:", systemPrompt.slice(0, 80) + "…");
    console.log("[preview-model] materials:", brief.slice(0, 120) + "…");
    // 从材料里抓几个「原文」片段，模拟模型逐字摘录；不编造。
    const lines = brief.split("\n").map((line) => line.trim()).filter(Boolean);
    const materialLines = lines.filter((line) => !line.startsWith("来源名称：") && !line.startsWith("来源链接："));
    const first = materialLines[0] ?? "";
    const withDate = materialLines.find((line) => /20\d{2}/.test(line)) ?? first;
    const conditions = materialLines.find((line) => /仅限|试点|截止|以.*为准/.test(line)) ?? "";
    const title = first.slice(0, 60) || "事件标题（样例）";
    const reply = {
      title,
      type: "product_launch",
      subjectKind: "brand",
      subjectName: "本公司",
      eventTime: withDate.match(/20\d{2}[^\s，。；]*/)?.[0] ?? null,
      conditions: conditions || null,
      scope: "excerpt",
      limitations: "仅取得材料片段，未做独立来源核验。",
      citations: {
        subject: "本公司",
        eventTime: withDate.match(/20\d{2}[^\s，。；]*/)?.[0] ?? null,
        conditions: conditions || null,
      },
    };
    return JSON.stringify(reply);
  },
};

const identity = {
  platform: "feishu",
  applicationId: "cli_local_preview",
  tenantId: "tenant_local_preview",
  idType: "open_id",
  externalId: "ou_local_preview",
};

const server = createApi(runtime, {
  service: new (await import("../packages/core/dist/index.js")).AuthenticationService(storage),
  publicOrigin: PUBLIC_ORIGIN,
  audit(event) {
    console.log("[audit]", JSON.stringify(event));
  },
  provider: {
    // 真实 OAuth 流程：login 跳到 callback（带 state/code），callback 里假 provider 校验通过并 set-cookie。
    authorizationUrl({ state, redirectUri }) {
      const url = new URL(redirectUri);
      url.searchParams.set("state", state);
      url.searchParams.set("code", "preview-code");
      return url.toString();
    },
    async verifyAuthorizationCode() {
      return { identity, displayName: "本地预览用户" };
    },
  },
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`\n=== 本地预览 API 已启动: http://127.0.0.1:${PORT} ===`);
  console.log("⚠️  假身份 + 样例模型输出 + 内存存储；仅用于试 UI 手感，不是真机验收。");
  console.log("下一步（另一个终端）：cd apps/console && bun run dev");
  console.log("然后打开 http://localhost:5173，点「使用飞书登录」会自动完成假登录。\n");
});

const stop = () => {
  server.close(() => process.exit(0));
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
