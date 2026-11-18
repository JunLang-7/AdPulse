# Proposal：假设偏差信号——第三类信号的落地设计

## 1. 动机

README 将「假设偏差」列为三类重点信号之一：当前方案依赖的判断开始得到支持，或受到新证据挑战。当前代码只有市场变化（#38）与效果变化（#9/#10）两类，假设偏差无任何对应机制，是产品核心承诺与实现之间最大的缺口。

本提案定义假设的一等公民模型、AI 辅助生成与迭代流程、自动初判与人工确认机制，以及向现有提醒管线的接线方式。

## 2. 基本概念

**假设**是当前推广任务所依赖的一条可被证据支持或挑战的判断，例如「目标人群对免费试用装的反应优于直接折扣」。它：

- 绑定任务与策略版本（判断属于「现在为什么这样投」的依据）；
- 必须可判定：能够说清什么证据会支持它、什么证据会挑战它；
- 只陈述判断，不包装为事实；未确认前保持草稿或待定状态。

**判定（verdict）**是一条证据对一条假设的关系记录：支持（supports）、挑战（challenges）或不足以判断（unclear）。判定只说明新证据与既有判断的关系，不重新认定事实。

## 3. 领域模型（core）

```ts
export interface Hypothesis {
  id: string;
  ownerId: string;
  taskId: string;
  /** 假设挂靠的策略版本，策略变更后旧假设保留历史归属 */
  taskVersion: number;
  currentVersion: number;
  status: HypothesisStatus;
  createdAt: string;
}

export type HypothesisStatus =
  | "draft"        // 模型生成、未经用户确认
  | "open"         // 用户已确认，持续观察
  | "supported"    // 存在用户确认的支持判定
  | "challenged"   // 存在用户确认的挑战判定
  | "retired";     // 用户主动停用（不再作为方案依据）

export interface HypothesisVersion {
  id: string; hypothesisId: string; version: number;
  /** 假设陈述，≤200 字 */
  statement: string;
  /** 当前方案为什么依赖这条判断，≤500 字 */
  rationale: string;
  /** 用户可编辑的「什么证据会支持/挑战」说明，≤400 字 */
  testable?: string;
  origin: "manual" | "model_draft_accepted";
  createdAt: string;
}

export interface HypothesisVerdict {
  id: string;
  hypothesisId: string;
  hypothesisVersion: number;
  subject:
    | { kind: "market_event"; eventId: string; version: number }
    | { kind: "source_item"; sourceItemId: string }
    | { kind: "comparison"; comparisonResultId: string };
  judgment: "supports" | "challenges" | "unclear";
  /** 判定依据说明；自动初判由模型生成，必须引用原文 */
  explanation: string;
  stage: "preliminary" | "confirmed" | "rejected";
  preliminary?: { modelRef: string; generatedAt: string };
  confirmedAt?: string;
  createdAt: string;
}
```

### 状态机

- `draft` --用户确认--> `open`（写 `origin: model_draft_accepted` 的版本）
- `open/supported/challenged` --用户确认 challenges 判定--> `challenged`
- 同上 --用户确认 supports 判定--> `supported`
- 任意非 `retired` --用户停用--> `retired`
- `draft` --用户拒绝--> 删除草稿（不留判定）
- `rejected` 初判不改变状态，仅留痕

规则：

1. **只有用户确认的判定能改变状态**；`preliminary` 初判只入待确认队列。
2. 状态变更写版本化操作记录（幂等 key + digest），沿袭现有 MarketEventOperation 模式。
3. 假设修订生成新版本；已确认判定挂在产生时的假设版本上。
4. 生命周期（#40）：任务删除时假设及其判定随任务清理，进入删除清单。

## 4. AI 辅助生成与对话迭代

复用 task-draft-extractor 的全部基础设施：用户模型连接与凭据、目录与供应商覆盖、双层限流（owner 6 次/分钟并发 1、实例 8 次/分钟并发 2）、model-egress 出网管控、12s 超时、仅 JSON 响应、逐字摘录与不编造约束。

### 4.1 生成（表单式）

输入：任务说明（复用 task brief）+ 当前 Strategy（objective/audience/sellingPoints/channels）+ 已录入市场事件标题摘要（如有）。

输出草案（每条）：

```json
{
  "statement": "可被证据支持或挑战的一条判断，≤200字",
  "rationale": "当前方案为什么依赖它，≤500字",
  "testable": "什么证据会支持它、什么证据会挑战它，≤400字",
  "evidenceHint": { "verbatim": "任务说明中的逐字摘录，可为空" }
}
```

约束沿袭 task-draft：

- statement 只能改写用户材料中已有的判断，不得编造功效、认证、数据、竞品行为；
- evidenceHint 若提供必须逐字摘录；
- 每次生成 3-5 条草案，覆盖不同依据来源（人群、卖点、渠道、价格敏感度）；
- 无从判断时返回空数组，不凑数。

### 4.2 对话迭代

用户对草案逐条处理：**接受 / 编辑后接受 / 拒绝**；并可发一条反馈消息（如「第2条太宽泛，聚焦到装修人群」），模型基于反馈重新生成修订草案。迭代同样受限流与摘录约束；修订草案标注「已修订」痕迹，原草案保留在草稿列表中供比对。

### 4.3 网络边界

模型调用一律不出现在存储事务内（沿用现有规则）。生成与迭代为同步 API（对齐 task-draft 现有形态）；初判为异步 job。

## 5. 自动初判 + 人工确认

### 5.1 触发点

以下事件发生且已关联任务时，为该任务下状态非 `retired/draft` 的假设生成初判 job：

1. 市场事件创建或修订（#38，非模拟、含 taskRefs）；
2. 期次比较结果产生（#9，status 任意，附比较结论）。

### 5.2 初判内容

模型输入：假设（statement/testable）+ 证据材料（事件标题/摘要原文、比较结论与关键数字）。输出：

```json
{
  "judgment": "supports | challenges | unclear",
  "explanation": "依据原文的说明，≤300字，须引用事件或证据中的具体表述",
  "quote": "逐字引用的关键原文，可为空"
}
```

规则：判定必须是「新证据与既有判断」的关系，不重述事实；原文不足以判断时必须返回 `unclear`，不得推测；一次初判只针对一条假设与一条证据。

### 5.3 人工确认

初判写入 `stage: "preliminary"`，在控制台任务详情「假设」面板以待确认列表展示。用户操作：

- **确认**：判定转为 `confirmed`，若为 supports/challenges 则变更假设状态并触发提醒；
- **驳回**：判定转为 `rejected`，仅留痕，不改状态、不提醒。

驳回原因本期不强制填写；误报统计（提案 market-signal-alerts §反馈记录）另行接。

## 6. 提醒接线（本期完成）

复用 #37 主动通知批次/去重与 #112 本人任务订阅筛选：

- 触发：用户确认判定且假设状态变更为 `supported` 或 `challenged` 时；
- 渠道：进入现有定时汇总与通知记录投影（不做独立即时推送通道，与效果告警一致走订阅筛选）；
- 去重：dedupKey = hypothesisId + verdictId，同一判定不重复推送，不补历史；
- 内容：假设陈述、判定（支持/挑战）、证据引用、确认时间与说明；明确标注「由用户确认，依据为所引证据」；
- 边界：模拟数据来源的判定不推送（对齐 #38 模拟标记规则）。

## 7. API（S3）

| 端点 | 说明 |
| --- | --- |
| `GET /adpulse/tasks/{taskId}/hypotheses` | 列表（含版本、判定摘要、待确认初判数） |
| `POST /adpulse/tasks/{taskId}/hypotheses/drafts` | 模型生成草案（同步、限流内） |
| `POST /adpulse/tasks/{taskId}/hypotheses/drafts/iterate` | 反馈消息迭代修订 |
| `POST /adpulse/tasks/{taskId}/hypotheses` | 确认草案或手动录入（幂等 key） |
| `PATCH /adpulse/hypotheses/{id}` | 修订陈述/依据（新版本）或停用 |
| `POST /adpulse/hypotheses/{id}/verdicts` | 手动判定（幂等 key） |
| `POST /adpulse/hypotheses/verdicts/{verdictId}/confirm` | 确认初判（状态变更在此发生） |
| `POST /adpulse/hypotheses/verdicts/{verdictId}/reject` | 驳回初判 |

全部按 owner 校验归属；OpenAPI 同步，`bun run sdk:generate` 生成客户端；控制台不手写 HTTP 契约。

## 8. 控制台 UI（S4）

任务详情新增「假设」面板：

- 生成流：分步表单（对齐 task-setup 形态）→ 草案卡片（接受/编辑/拒绝/反馈迭代）；
- 假设列表：状态徽标（观察中/被支持/被挑战/已停用）、版本与依据摘要；
- 待确认初判：证据引用 + 模型说明与逐字引用 → 确认/驳回；
- 判定记录时间线：每条判定显示证据、判定、说明与阶段。

UI 行为变更补组件测试；操作路径与预期结果记入 PR 说明。

## 9. 验收标准（合成数据）

| 情形 | 输入与预期 |
| --- | --- |
| 生成草案 | 含人群与卖点的任务说明 → 3-5 条草案，statement 不含编造数据；材料无判断依据时返回空 |
| 用户确认 | 接受 2 条草案 → 假设 `open`，origin 为 model_draft_accepted；拒绝 1 条 → 不落库 |
| 对话迭代 | 反馈「聚焦装修人群」→ 修订草案仅调整相关陈述，原草案可回看 |
| 自动初判-挑战 | 新市场事件「竞品推出同类免费试用」→ 初判 challenges + 逐字引用；用户确认 → 假设 `challenged` 并产生提醒 |
| 自动初判-驳回 | 同上但用户驳回 → 状态不变、无提醒、留痕 rejected |
| 初判为 unclear | 事件原文与假设无直接关系 → 模型必须返回 unclear；强行判定视为缺陷 |
| 手动判定 | 用户对效果比较结果手动 supports → 状态 `supported`，进提醒管线 |
| 幂等与并发 | 重复提交同一 key → 复用原结果；版本冲突 409 |
| 权限 | 他人任务的假设与判定一律 404/403 |
| 模拟数据 | 模拟事件来源的初判确认后不推送提醒，仅状态变更 |
| 任务删除 | 删除任务后假设、判定、待确认初判全部不可访问 |

## 10. 拆分与红线

按堆叠 PR 分段：S1 core 模型与服务 → S2 生成/初判模型连接 → S3 API 与客户端 → S4 控制台 → S5 提醒接线。每段独立可验证。

红线：模型输出只是草案与初判，事实以用户确认为准；网络请求不出事务；不改投放执行边界；README「当前阶段」随实现同步修订（对应问题一的文档修正，不在本提案内）。
