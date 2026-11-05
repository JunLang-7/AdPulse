# AdPulse 控制台

Vite + React + shadcn/ui 的 AdPulse 运营控制台，通过生成的 OpenAPI SDK 调用 `apps/api`。

## 目录

```
src/
  adpulse-client.ts       基于 openapi-fetch 的类型化客户端
  generated/api.d.ts      由 contracts/openapi.json 生成，不要手改
  routes/Router.tsx       路由表（会话列表 / 会话详情）
  views/adpulse/          业务页面
  layouts/full/           壳子：侧边栏、Header、页脚
  components/ui/          按需保留的 shadcn 组件
```

## 命令

```bash
bun run dev        # 开发服务器，默认 http://localhost:5173
bun run typecheck
bun run build      # 产物在 dist/
bun run sdk:generate   # 契约变更后重新生成 API 类型
bun run sdk:check      # 校验生成类型是否与契约一致
```

开发时 `/api` 由 Vite 代理到 `http://127.0.0.1:3000`，因此不需要处理跨域。
`VITE_API_BASE_URL` 与 `VITE_CONSOLE_TOKEN` 默认从仓库根目录 `.env` 读取
（`API_BASE_URL` / `CONSOLE_TOKEN`）。

## 依赖约定

- 只保留当前页面真正用到的依赖；新增 UI 组件时用 `npx shadcn@latest add <component>` 引入，再补依赖。
- 页面只通过 `consoleClient` 访问后端，不手写 `fetch`。

## 界面来源与许可

壳子与组件库复用 [shadcndashboard](https://github.com/shadcndashboard/shadcndashboard)（MIT），
保留其 `LICENSE`。业务页面、路由与数据接入为 AdPulse 自有实现。
