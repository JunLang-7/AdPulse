<!-- 由 `bun run model-coverage:generate` 生成，勿手改。 -->

# 模型供应商覆盖清单

来源：锁定版本 `@earendil-works/pi-ai@1.5.0` 的完整供应商目录。
本表由目录生成，不是手工维护的品牌白名单；改锁定版本后重跑生成命令并提交。

状态是四个独立事实，不能互相替代：

1. **目录存在**：SDK 里有这个供应商与模型。
2. **AdPulse 适配可用**：本期只接通“个人 API Key + OpenAI Chat Completions”。
3. **本人已配置密钥**：运行时数据，不在本文档里。
4. **真实供应商验收**：逐家真实联调；本表统一记为“未验收”，不因目录存在或合成测试通过而改写。

汇总：42 个供应商；20 个可直连（235 个模型）；22 个未接通；真实供应商验收 0 个。

| # | 供应商 | Provider ID | 认证 | 协议 | 目录模型 | AdPulse 适配 | 真实验收 |
| -: | --- | --- | --- | --- | -: | --- | --- |
| 1 | Ant Ling | `ant-ling` | API Key | `openai-completions` | 3 | 可直连（个人 API Key · Chat Completions） | 未验收 |
| 2 | Baseten | `baseten` | API Key | `openai-completions` | 14 | 可直连（个人 API Key · Chat Completions） | 未验收 |
| 3 | Cerebras | `cerebras` | API Key | `openai-completions` | 2 | 可直连（个人 API Key · Chat Completions） | 未验收 |
| 4 | DeepSeek | `deepseek` | API Key | `openai-completions` | 2 | 可直连（个人 API Key · Chat Completions） | 未验收 |
| 5 | Fireworks | `fireworks` | API Key | `anthropic-messages` / `openai-completions` | 10 | 可直连（个人 API Key · Chat Completions） | 未验收 |
| 6 | Groq | `groq` | API Key | `openai-completions` | 7 | 可直连（个人 API Key · Chat Completions） | 未验收 |
| 7 | Hugging Face | `huggingface` | API Key | `openai-completions` | 78 | 可直连（个人 API Key · Chat Completions） | 未验收 |
| 8 | Moonshot AI | `moonshotai` | API Key | `openai-completions` | 6 | 可直连（个人 API Key · Chat Completions） | 未验收 |
| 9 | Moonshot AI CN | `moonshotai-cn` | API Key | `openai-completions` | 6 | 可直连（个人 API Key · Chat Completions） | 未验收 |
| 10 | NVIDIA | `nvidia` | API Key | `openai-completions` | 21 | 可直连（个人 API Key · Chat Completions） | 未验收 |
| 11 | Qwen Token Plan | `qwen-token-plan` | API Key | `openai-completions` | 21 | 可直连（个人 API Key · Chat Completions） | 未验收 |
| 12 | Qwen Token Plan CN | `qwen-token-plan-cn` | API Key | `openai-completions` | 21 | 可直连（个人 API Key · Chat Completions） | 未验收 |
| 13 | Qwen Token Plan Individual | `qwen-token-plan-individual` | API Key | `openai-completions` | 9 | 可直连（个人 API Key · Chat Completions） | 未验收 |
| 14 | Together | `together` | API Key | `openai-completions` | 15 | 可直连（个人 API Key · Chat Completions） | 未验收 |
| 15 | Xiaomi | `xiaomi` | API Key | `openai-completions` | 3 | 可直连（个人 API Key · Chat Completions） | 未验收 |
| 16 | Xiaomi Token Plan AMS | `xiaomi-token-plan-ams` | API Key | `openai-completions` | 2 | 可直连（个人 API Key · Chat Completions） | 未验收 |
| 17 | Xiaomi Token Plan CN | `xiaomi-token-plan-cn` | API Key | `openai-completions` | 2 | 可直连（个人 API Key · Chat Completions） | 未验收 |
| 18 | Xiaomi Token Plan SGP | `xiaomi-token-plan-sgp` | API Key | `openai-completions` | 2 | 可直连（个人 API Key · Chat Completions） | 未验收 |
| 19 | Z.AI | `zai` | API Key | `openai-completions` | 7 | 可直连（个人 API Key · Chat Completions） | 未验收 |
| 20 | Z.AI Coding CN | `zai-coding-cn` | API Key | `openai-completions` | 4 | 可直连（个人 API Key · Chat Completions） | 未验收 |
| 21 | Amazon Bedrock | `amazon-bedrock` | API Key | `bedrock-converse-stream` | 0 | 未接通：需要账号、区域或部署名等额外参数，本期未接入。 | 未验收 |
| 22 | Anthropic | `anthropic` | API Key / 账号授权（OAuth） | `anthropic-messages` | 0 | 未接通：该供应商使用 anthropic-messages 原生协议，尚未接通。 | 未验收 |
| 23 | Azure | `azure` | API Key | `azure-openai-responses` / `openai-completions` | 0 | 未接通：需要账号、区域或部署名等额外参数，本期未接入。 | 未验收 |
| 24 | Cloudflare AI Gateway | `cloudflare-ai-gateway` | API Key | `anthropic-messages` / `openai-completions` / `openai-responses` | 0 | 未接通：需要账号、区域或部署名等额外参数，本期未接入。 | 未验收 |
| 25 | Cloudflare Workers AI | `cloudflare-workers-ai` | API Key | `openai-completions` | 0 | 未接通：需要账号、区域或部署名等额外参数，本期未接入。 | 未验收 |
| 26 | GitHub Copilot | `github-copilot` | API Key / 账号授权（OAuth） | `anthropic-messages` / `openai-completions` / `openai-responses` | 0 | 未接通：该供应商还依赖账号授权（OAuth），本期只支持个人 API Key 直连。 | 未验收 |
| 27 | Google | `google` | API Key | `google-generative-ai` | 0 | 未接通：该供应商使用 google-generative-ai 原生协议，尚未接通。 | 未验收 |
| 28 | Google Vertex AI | `google-vertex` | API Key | `google-vertex` | 0 | 未接通：需要账号、区域或部署名等额外参数，本期未接入。 | 未验收 |
| 29 | Kimi For Coding | `kimi-coding` | API Key / 账号授权（OAuth） | `openai-completions` | 0 | 未接通：该供应商还依赖账号授权（OAuth），本期只支持个人 API Key 直连。 | 未验收 |
| 30 | Meta | `meta` | API Key / 账号授权（OAuth） | `openai-responses` | 0 | 未接通：该供应商使用 openai-responses 原生协议，尚未接通。 | 未验收 |
| 31 | MiniMax | `minimax` | API Key | `anthropic-messages` | 0 | 未接通：该供应商使用 anthropic-messages 原生协议，尚未接通。 | 未验收 |
| 32 | MiniMax CN | `minimax-cn` | API Key | `anthropic-messages` | 0 | 未接通：该供应商使用 anthropic-messages 原生协议，尚未接通。 | 未验收 |
| 33 | Mistral | `mistral` | API Key | `mistral-conversations` | 0 | 未接通：该供应商使用 mistral-conversations 原生协议，尚未接通。 | 未验收 |
| 34 | OpenAI | `openai` | API Key / 账号授权（OAuth） | `openai-responses` | 0 | 未接通：该供应商使用 openai-responses 原生协议，尚未接通。 | 未验收 |
| 35 | OpenAI Codex (legacy) | `openai-codex` | 账号授权（OAuth） | `openai-codex-responses` | 0 | 未接通：该供应商使用 openai-codex-responses 原生协议，尚未接通。 | 未验收 |
| 36 | OpenCode Zen | `opencode` | API Key | `anthropic-messages` / `google-generative-ai` / `openai-completions` / `openai-responses` | 0 | 未接通：需要账号、区域或部署名等额外参数，本期未接入。 | 未验收 |
| 37 | OpenCode Go | `opencode-go` | API Key | `anthropic-messages` / `google-generative-ai` / `openai-completions` / `openai-responses` | 0 | 未接通：需要账号、区域或部署名等额外参数，本期未接入。 | 未验收 |
| 38 | OpenRouter | `openrouter` | API Key / 账号授权（OAuth） | `anthropic-messages` / `openai-completions` | 0 | 未接通：该供应商还依赖账号授权（OAuth），本期只支持个人 API Key 直连。 | 未验收 |
| 39 | Radius | `radius` | API Key / 账号授权（OAuth） | `pi-messages` | 0 | 未接通：需要账号、区域或部署名等额外参数，本期未接入。 | 未验收 |
| 40 | TypeSafe | `typesafe` | API Key | — | 0 | 未接通：目录中暂无对话模型。 | 未验收 |
| 41 | Vercel AI Gateway | `vercel-ai-gateway` | API Key | `anthropic-messages` | 0 | 未接通：该供应商使用 anthropic-messages 原生协议，尚未接通。 | 未验收 |
| 42 | xAI | `xai` | API Key / 账号授权（OAuth） | `openai-responses` | 0 | 未接通：该供应商使用 openai-responses 原生协议，尚未接通。 | 未验收 |

## 差异与后续

- 未接通的主因：原生协议未适配（`openai-responses`、`anthropic-messages`、`google-generative-ai`、`mistral-conversations`、`bedrock-converse-stream` 等），或需要账号/区域/部署名等额外参数，或依赖 OAuth 账号授权。
- `google-generative-ai` 的 pi-ai 适配器拒绝自定义 `fetch`，要纳入受控出网需要自研传输层，不能直接开启。
- 接入新协议时，必须同时补：协议适配、合成响应测试、二次验证与共享限额复用、“真实供应商验收”单独取证。
