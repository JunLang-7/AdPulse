<!-- 由 `bun run model-diff:generate` 生成，勿手改。 -->

# 与 Harness 参考目录的逐家差异

参考提交：[`e8f7b93a344964de3dca1ace9e72b6e4d6de87cb`](https://github.com/deepseek-ai/deepseek-harness/tree/e8f7b93a344964de3dca1ace9e72b6e4d6de87cb)，
取 `packages/llm/llm-pi-ai/src/provider-data.generated.ts`（由 Harness 的 `gen-provider-data` 从当时安装的 pi-ai 目录生成）。
该提交的 pi-ai 依赖为 `^1.3.0`；AdPulse 锁定 `@earendil-works/pi-ai@1.5.0`。

## 结论

- 供应商集合一致：双方各 42 家，仅 Harness 有 0 家，仅 AdPulse 有 0 家。
- **版本不同**：参考提交用 `^1.3.0`，本仓库锁 1.5.0，因此模型清单与个别端点差异来自 SDK 版本，不能直接按本表推算对方模型数。
- AdPulse 可直连 29 家、1030 个模型（个人 API Key + `openai-completions` / `openai-responses` / `anthropic-messages`）；其余家保留在目录里并写明原因，不隐藏。
- 自定义协议：已接通 3 种；Harness 表单里的 `google-generative-ai` 仍未接通（pi-ai 适配器拒绝自定义 fetch，要纳入受控出网需自研传输）。
- 认证范围不同：Harness 接受账号登录、云凭据链与多环境变量；AdPulse 本期只接受**个人 API Key**，不读取部署环境凭据或其他人的密钥。
- 真实供应商验收：双方在本表中都**没有**验收证据；本表只说明目录覆盖与适配状态。

## 逐家对照

| Provider | Harness 认证变量数 | Harness 认证入口 | Harness 默认端点 | AdPulse 目录端点 | AdPulse 适配 |
| --- | -: | --- | --- | --- | --- |
| `amazon-bedrock` | 7 | 云凭据/账号 | `—` | `—` | 未接通：需要账号、区域或部署名等额外参数，本期未接入。 |
| `ant-ling` | 1 | 个人 Key 或更多 | `https://api.ant-ling.com/v1` | `https://api.ant-ling.com/v1` | 可直连（个人 API Key · Chat Completions） |
| `anthropic` | 8 | 个人 Key 或更多 | `https://api.anthropic.com` | `https://api.anthropic.com` | 可直连（个人 API Key · Anthropic Messages） |
| `azure` | 1 | 个人 Key 或更多 | `—` | `—` | 未接通：需要账号、区域或部署名等额外参数，本期未接入。 |
| `baseten` | 1 | 个人 Key 或更多 | `https://inference.baseten.co/v1` | `https://inference.baseten.co/v1` | 可直连（个人 API Key · Chat Completions） |
| `cerebras` | 1 | 个人 Key 或更多 | `https://api.cerebras.ai/v1` | `https://api.cerebras.ai/v1` | 可直连（个人 API Key · Chat Completions） |
| `cloudflare-ai-gateway` | 3 | 个人 Key 或更多 | `—` | `—` | 未接通：需要账号、区域或部署名等额外参数，本期未接入。 |
| `cloudflare-workers-ai` | 2 | 个人 Key 或更多 | `—` | `—` | 未接通：需要账号、区域或部署名等额外参数，本期未接入。 |
| `deepseek` | 1 | 个人 Key 或更多 | `https://api.deepseek.com` | `https://api.deepseek.com` | 可直连（个人 API Key · Chat Completions） |
| `fireworks` | 1 | 个人 Key 或更多 | `https://api.fireworks.ai/inference` | `https://api.fireworks.ai/inference` | 可直连（个人 API Key · Anthropic Messages / Chat Completions） |
| `github-copilot` | 1 | 个人 Key 或更多 | `https://api.individual.githubcopilot.com` | `https://api.individual.githubcopilot.com` | 未接通：该供应商使用 SDK 的专用认证与动态请求头分支，个人 API Key 直连暂不适用。 |
| `google` | 1 | 个人 Key 或更多 | `https://generativelanguage.googleapis.com/v1beta` | `https://generativelanguage.googleapis.com/v1beta` | 未接通：该供应商只提供 google-generative-ai 等原生协议，尚未适配。 |
| `google-vertex` | 5 | 个人 Key 或更多 | `—` | `—` | 未接通：需要账号、区域或部署名等额外参数，本期未接入。 |
| `groq` | 1 | 个人 Key 或更多 | `https://api.groq.com/openai/v1` | `https://api.groq.com/openai/v1` | 可直连（个人 API Key · Chat Completions） |
| `huggingface` | 1 | 个人 Key 或更多 | `https://router.huggingface.co/v1` | `https://router.huggingface.co/v1` | 可直连（个人 API Key · Chat Completions） |
| `kimi-coding` | 1 | 个人 Key 或更多 | `https://api.kimi.com/coding/v1` | `https://api.kimi.com/coding/v1` | 可直连（个人 API Key · Chat Completions） |
| `meta` | 1 | 个人 Key 或更多 | `https://api.meta.ai/v1` | `https://api.meta.ai/v1` | 可直连（个人 API Key · Responses） |
| `minimax` | 1 | 个人 Key 或更多 | `https://api.minimax.io/anthropic` | `https://api.minimax.io/anthropic` | 可直连（个人 API Key · Anthropic Messages） |
| `minimax-cn` | 1 | 个人 Key 或更多 | `https://api.minimaxi.com/anthropic` | `https://api.minimaxi.com/anthropic` | 可直连（个人 API Key · Anthropic Messages） |
| `mistral` | 1 | 个人 Key 或更多 | `https://api.mistral.ai` | `https://api.mistral.ai` | 未接通：该供应商只提供 mistral-conversations 等原生协议，尚未适配。 |
| `moonshotai` | 1 | 个人 Key 或更多 | `https://api.moonshot.ai/v1` | `https://api.moonshot.ai/v1` | 可直连（个人 API Key · Chat Completions） |
| `moonshotai-cn` | 1 | 个人 Key 或更多 | `https://api.moonshot.cn/v1` | `https://api.moonshot.cn/v1` | 可直连（个人 API Key · Chat Completions） |
| `nvidia` | 1 | 个人 Key 或更多 | `https://integrate.api.nvidia.com/v1` | `https://integrate.api.nvidia.com/v1` | 可直连（个人 API Key · Chat Completions） |
| `openai` | 1 | 个人 Key 或更多 | `https://api.openai.com/v1` | `https://api.openai.com/v1` | 可直连（个人 API Key · Responses） |
| `openai-codex` | 0 | 账号授权（OAuth） | `https://chatgpt.com/backend-api` | `https://chatgpt.com/backend-api` | 未接通：该供应商只提供 openai-codex-responses 等原生协议，尚未适配。 |
| `opencode` | 1 | 个人 Key 或更多 | `—` | `—` | 未接通：需要账号、区域或部署名等额外参数，本期未接入。 |
| `opencode-go` | 1 | 个人 Key 或更多 | `—` | `—` | 未接通：需要账号、区域或部署名等额外参数，本期未接入。 |
| `openrouter` | 1 | 个人 Key 或更多 | `https://openrouter.ai/api/v1` | `https://openrouter.ai/api/v1` | 可直连（个人 API Key · Anthropic Messages / Chat Completions） |
| `qwen-token-plan` | 1 | 个人 Key 或更多 | `https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1` | `https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1` | 可直连（个人 API Key · Chat Completions） |
| `qwen-token-plan-cn` | 1 | 个人 Key 或更多 | `https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1` | `https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1` | 可直连（个人 API Key · Chat Completions） |
| `qwen-token-plan-individual` | 1 | 个人 Key 或更多 | `https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1` | `https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1` | 可直连（个人 API Key · Chat Completions） |
| `radius` | 1 | 个人 Key 或更多 | `https://radius.pi.dev/v1` | `—` | 未接通：需要账号、区域或部署名等额外参数，本期未接入。 |
| `together` | 1 | 个人 Key 或更多 | `https://api.together.ai/v1` | `https://api.together.ai/v1` | 可直连（个人 API Key · Chat Completions） |
| `typesafe` | 1 | 个人 Key 或更多 | `—` | `—` | 未接通：目录中暂无对话模型。 |
| `vercel-ai-gateway` | 1 | 个人 Key 或更多 | `https://ai-gateway.vercel.sh` | `https://ai-gateway.vercel.sh` | 可直连（个人 API Key · Anthropic Messages） |
| `xai` | 1 | 个人 Key 或更多 | `https://api.x.ai/v1` | `https://api.x.ai/v1` | 可直连（个人 API Key · Responses） |
| `xiaomi` | 1 | 个人 Key 或更多 | `https://api.xiaomimimo.com/v1` | `https://api.xiaomimimo.com/v1` | 可直连（个人 API Key · Chat Completions） |
| `xiaomi-token-plan-ams` | 1 | 个人 Key 或更多 | `https://token-plan-ams.xiaomimimo.com/v1` | `https://token-plan-ams.xiaomimimo.com/v1` | 可直连（个人 API Key · Chat Completions） |
| `xiaomi-token-plan-cn` | 1 | 个人 Key 或更多 | `https://token-plan-cn.xiaomimimo.com/v1` | `https://token-plan-cn.xiaomimimo.com/v1` | 可直连（个人 API Key · Chat Completions） |
| `xiaomi-token-plan-sgp` | 1 | 个人 Key 或更多 | `https://token-plan-sgp.xiaomimimo.com/v1` | `https://token-plan-sgp.xiaomimimo.com/v1` | 可直连（个人 API Key · Chat Completions） |
| `zai` | 1 | 个人 Key 或更多 | `https://api.z.ai/api/coding/paas/v4` | `https://api.z.ai/api/coding/paas/v4` | 可直连（个人 API Key · Chat Completions） |
| `zai-coding-cn` | 1 | 个人 Key 或更多 | `https://open.bigmodel.cn/api/coding/paas/v4` | `https://open.bigmodel.cn/api/coding/paas/v4` | 可直连（个人 API Key · Chat Completions） |

## 未列入的差异

- 模型级差异（同一供应商的模型清单、价格、上下文）未逐项比对：参考快照只含端点与环境变量名，不含模型清单。
- Harness 的凭据文件、profile 与共享 credential reference 不在对照范围；AdPulse 明确不采用这些方式。
- 两家都未接通 `google-generative-ai` 之外的重型能力（图片/音视频、插件、任意 headers）不在本期范围。
