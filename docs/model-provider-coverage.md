<!-- 由 `bun run model-coverage:generate` 生成，勿手改。 -->

# 模型供应商覆盖清单

来源：锁定版本 `@earendil-works/pi-ai@1.5.0` 的完整供应商目录。
本表由锁定 pi-ai 目录生成；目录模型数包含未接通项，可直连汇总仅计算已适配模型。认证列保留 SDK 认证名称，apiKey 扩展点也可能代表云凭据链。尚未完成与 Harness 参考提交的逐项差异核对。

状态是四个独立事实，不能互相替代：

1. **目录存在**：SDK 里有这个供应商与模型。
2. **AdPulse 适配可用**：已接通“个人 API Key + OpenAI Chat Completions / Responses / Anthropic Messages”；通过的是合成适配测试。
3. **本人已配置密钥**：运行时数据，不在本文档里。
4. **真实供应商验收**：逐家真实联调；本表统一记为“未验收”，不因目录存在或合成测试通过而改写。

汇总：42 个供应商；29 个可直连（1030 个模型）；13 个未接通；真实供应商验收 0 个。

| # | 供应商 | Provider ID | 认证 | 协议 | 目录模型 | AdPulse 适配 | 真实验收 |
| -: | --- | --- | --- | --- | -: | --- | --- |
| 1 | Ant Ling | `ant-ling` | Ant Ling API key | `openai-completions` | 3 | 可直连（个人 API Key · Chat Completions） | 未验收 |
| 2 | Anthropic | `anthropic` | Anthropic API key / 账号授权（OAuth） | `anthropic-messages` | 17 | 可直连（个人 API Key · Anthropic Messages） | 未验收 |
| 3 | Baseten | `baseten` | Baseten API key | `openai-completions` | 14 | 可直连（个人 API Key · Chat Completions） | 未验收 |
| 4 | Cerebras | `cerebras` | Cerebras API key | `openai-completions` | 2 | 可直连（个人 API Key · Chat Completions） | 未验收 |
| 5 | DeepSeek | `deepseek` | DeepSeek API key | `openai-completions` | 2 | 可直连（个人 API Key · Chat Completions） | 未验收 |
| 6 | Fireworks | `fireworks` | Fireworks API key | `anthropic-messages` / `openai-completions` | 29 | 可直连（个人 API Key · Anthropic Messages / Chat Completions） | 未验收 |
| 7 | Groq | `groq` | Groq API key | `openai-completions` | 7 | 可直连（个人 API Key · Chat Completions） | 未验收 |
| 8 | Hugging Face | `huggingface` | Hugging Face token | `openai-completions` | 78 | 可直连（个人 API Key · Chat Completions） | 未验收 |
| 9 | Kimi For Coding | `kimi-coding` | Kimi API key / 账号授权（OAuth） | `openai-completions` | 6 | 可直连（个人 API Key · Chat Completions） | 未验收 |
| 10 | Meta | `meta` | Meta Model API key / 账号授权（OAuth） | `openai-responses` | 6 | 可直连（个人 API Key · Responses） | 未验收 |
| 11 | MiniMax | `minimax` | MiniMax API key | `anthropic-messages` | 4 | 可直连（个人 API Key · Anthropic Messages） | 未验收 |
| 12 | MiniMax CN | `minimax-cn` | MiniMax CN API key | `anthropic-messages` | 4 | 可直连（个人 API Key · Anthropic Messages） | 未验收 |
| 13 | Moonshot AI | `moonshotai` | Moonshot AI API key | `openai-completions` | 6 | 可直连（个人 API Key · Chat Completions） | 未验收 |
| 14 | Moonshot AI CN | `moonshotai-cn` | Moonshot AI API key | `openai-completions` | 6 | 可直连（个人 API Key · Chat Completions） | 未验收 |
| 15 | NVIDIA | `nvidia` | NVIDIA API key | `openai-completions` | 21 | 可直连（个人 API Key · Chat Completions） | 未验收 |
| 16 | OpenAI | `openai` | OpenAI API key / 账号授权（OAuth） | `openai-responses` | 44 | 可直连（个人 API Key · Responses） | 未验收 |
| 17 | OpenRouter | `openrouter` | OpenRouter API key / 账号授权（OAuth） | `anthropic-messages` / `openai-completions` | 388 | 可直连（个人 API Key · Anthropic Messages / Chat Completions） | 未验收 |
| 18 | Qwen Token Plan | `qwen-token-plan` | Qwen Token Plan API key | `openai-completions` | 21 | 可直连（个人 API Key · Chat Completions） | 未验收 |
| 19 | Qwen Token Plan CN | `qwen-token-plan-cn` | Qwen Token Plan CN API key | `openai-completions` | 21 | 可直连（个人 API Key · Chat Completions） | 未验收 |
| 20 | Qwen Token Plan Individual | `qwen-token-plan-individual` | Qwen Token Plan Individual API key | `openai-completions` | 9 | 可直连（个人 API Key · Chat Completions） | 未验收 |
| 21 | Together | `together` | Together API key | `openai-completions` | 15 | 可直连（个人 API Key · Chat Completions） | 未验收 |
| 22 | Vercel AI Gateway | `vercel-ai-gateway` | Vercel AI Gateway API key | `anthropic-messages` | 303 | 可直连（个人 API Key · Anthropic Messages） | 未验收 |
| 23 | xAI | `xai` | xAI API key / 账号授权（OAuth） | `openai-responses` | 4 | 可直连（个人 API Key · Responses） | 未验收 |
| 24 | Xiaomi | `xiaomi` | Xiaomi API key | `openai-completions` | 3 | 可直连（个人 API Key · Chat Completions） | 未验收 |
| 25 | Xiaomi Token Plan AMS | `xiaomi-token-plan-ams` | Xiaomi Token Plan AMS API key | `openai-completions` | 2 | 可直连（个人 API Key · Chat Completions） | 未验收 |
| 26 | Xiaomi Token Plan CN | `xiaomi-token-plan-cn` | Xiaomi Token Plan CN API key | `openai-completions` | 2 | 可直连（个人 API Key · Chat Completions） | 未验收 |
| 27 | Xiaomi Token Plan SGP | `xiaomi-token-plan-sgp` | Xiaomi Token Plan SGP API key | `openai-completions` | 2 | 可直连（个人 API Key · Chat Completions） | 未验收 |
| 28 | Z.AI | `zai` | Z.AI API key | `openai-completions` | 7 | 可直连（个人 API Key · Chat Completions） | 未验收 |
| 29 | Z.AI Coding CN | `zai-coding-cn` | Z.AI Coding CN API key | `openai-completions` | 4 | 可直连（个人 API Key · Chat Completions） | 未验收 |
| 30 | Amazon Bedrock | `amazon-bedrock` | AWS credentials or bearer token | `bedrock-converse-stream` | 197 | 未接通：需要账号、区域或部署名等额外参数，本期未接入。 | 未验收 |
| 31 | Azure | `azure` | Azure OpenAI API key | `azure-openai-responses` / `openai-completions` | 45 | 未接通：需要账号、区域或部署名等额外参数，本期未接入。 | 未验收 |
| 32 | Cloudflare AI Gateway | `cloudflare-ai-gateway` | Cloudflare API key | `anthropic-messages` / `openai-completions` / `openai-responses` | 59 | 未接通：需要账号、区域或部署名等额外参数，本期未接入。 | 未验收 |
| 33 | Cloudflare Workers AI | `cloudflare-workers-ai` | Cloudflare API key | `openai-completions` | 19 | 未接通：需要账号、区域或部署名等额外参数，本期未接入。 | 未验收 |
| 34 | GitHub Copilot | `github-copilot` | GitHub Copilot token / 账号授权（OAuth） | `anthropic-messages` / `openai-completions` / `openai-responses` | 27 | 未接通：该供应商使用 SDK 的专用认证与动态请求头分支，个人 API Key 直连暂不适用。 | 未验收 |
| 35 | Google | `google` | Gemini API key | `google-generative-ai` | 23 | 未接通：该供应商只提供 google-generative-ai 等原生协议，尚未适配。 | 未验收 |
| 36 | Google Vertex AI | `google-vertex` | Google Cloud credentials | `google-vertex` | 13 | 未接通：需要账号、区域或部署名等额外参数，本期未接入。 | 未验收 |
| 37 | Mistral | `mistral` | Mistral API key | `mistral-conversations` | 34 | 未接通：该供应商只提供 mistral-conversations 等原生协议，尚未适配。 | 未验收 |
| 38 | OpenAI Codex (legacy) | `openai-codex` | 账号授权（OAuth） | `openai-codex-responses` | 8 | 未接通：该供应商只提供 openai-codex-responses 等原生协议，尚未适配。 | 未验收 |
| 39 | OpenCode Zen | `opencode` | OpenCode API key | `anthropic-messages` / `google-generative-ai` / `openai-completions` / `openai-responses` | 79 | 未接通：需要账号、区域或部署名等额外参数，本期未接入。 | 未验收 |
| 40 | OpenCode Go | `opencode-go` | OpenCode API key | `anthropic-messages` / `google-generative-ai` / `openai-completions` / `openai-responses` | 30 | 未接通：需要账号、区域或部署名等额外参数，本期未接入。 | 未验收 |
| 41 | Radius | `radius` | Radius API key / 账号授权（OAuth） | `pi-messages` | 28 | 未接通：需要账号、区域或部署名等额外参数，本期未接入。 | 未验收 |
| 42 | TypeSafe | `typesafe` | TypeSafe API key | — | 0 | 未接通：目录中暂无对话模型。 | 未验收 |

## 差异与后续

- 未接通的主因：原生协议未适配（`google-generative-ai`、`mistral-conversations`、`bedrock-converse-stream` 等），或需要账号/区域/部署名等额外参数，或仅提供账号授权。提供可选 OAuth 不妨碍其个人 API Key 路径单独接入。
- `google-generative-ai` 的 pi-ai 适配器拒绝自定义 `fetch`，要纳入受控出网需要自研传输层，不能直接开启。
- 接入新协议时，必须同时补：协议适配、合成响应测试、二次验证与共享限额复用、“真实供应商验收”单独取证。
