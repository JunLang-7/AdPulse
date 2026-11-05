# AdPulse 控制台

Vite + React + shadcn/ui 的 AdPulse 运营控制台，通过生成的 OpenAPI SDK 调用 `apps/api`。

## 目录

```
src/
  adpulse-client.ts       基于 openapi-fetch 的类型化客户端
  generated/api.d.ts      由 contracts/openapi.json 生成，不要手改
  routes/Router.tsx       路由表（会话列表 / 会话详情）
  views/adpulse/          业务页面
  layouts/full/           壳子：侧边栏、Header（无页面页脚）
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

先在仓库根目录按开发指南配置 `.env`，执行 `bun run build`、`bun run start` 启动 API，再在本目录启动开发服务器。
开发时 `/api`、`/webhooks` 由 Vite 代理到 `http://127.0.0.1:3000`，默认不需要处理跨域。

- `VITE_API_BASE_URL` 默认空字符串，即同源代理；它**不会**回退到 `API_BASE_URL`。API_BASE_URL 仅供 demo 等脚本使用，改 API 端口时需同步修改 Vite proxy 目标。
- `VITE_CONSOLE_TOKEN` 默认从仓库根目录 `.env` 读取；未设置时回退到 `CONSOLE_TOKEN`。修改后重启 Vite。
- token 会进入浏览器及前端构建产物，仅用于受控开发环境；不要公开发布包含真实 token 的静态产物。生产认证/反向代理另行设计。

## 当前可用范围

- `/sessions`：会话列表、状态、轮次与版本摘要。
- `/sessions/:sessionId`：轮次、并列候选（选中打钩）、投递回执与快照摘要；有效且可操作的选项可提交。
- 左栏只含会话列表，底部为使用文档/问题反馈，无占位页面。
- 没有创建表单；可在根目录运行 `bun run demo` 生成已完成记录，或参考脚本通过 API 创建待处理会话。
- 提交返回 202 不是业务已生效。当前只触发一次查询失效，尚未持续跟踪 processed/rejected/failed，必要时刷新核对；快照也尚未展示具体差异。后续见 [#11](https://github.com/JunLang-7/AdPulse/issues/11)。

## 依赖约定

- 只保留当前页面真正用到的依赖；新增 UI 组件时用 `npx shadcn@latest add <component>` 引入，再补依赖。
- 页面只通过 `consoleClient` 访问后端，不手写 `fetch`。

## 界面来源与许可

壳子与组件库复用 [shadcndashboard](https://github.com/shadcndashboard/shadcndashboard)（MIT），
保留其 `LICENSE`。业务页面、路由与数据接入为 AdPulse 自有实现。
