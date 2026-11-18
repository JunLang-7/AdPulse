# Proposal：从已应用变更到验证结果的最小闭环（S1–S3 第一版已实现）

> 实现状态：S1–S3 第一版已落地（检查点创建、到期评估、owner 手动重评、下一轮只读上下文）。与草案的差异：按候选建一条检查点而非按变更拆分；到期只关联同任务版本、接受之后、可评估的最新比较结果；达人/种草仍未建模指标。

## 1. 背景

README 要求调整建议交代「如何验证，什么情况下继续、调整或停止」。本分支已经让候选可以携带 `hypothesis` / `validationPlan`，并在用户接受后随策略快照冻结；但系统仍然不知道这些计划后来有没有被验证。

结果就是：建议能说清「准备怎么验证」，却无法回答「验证结果如何」。这不是 bug，而是缺少一个把已应用变更与后续证据连起来的实体。

## 2. 现状

- 候选：`hypothesis` / `validationPlan` 可选，单行 ≤300 字；卡片展示，快照冻结。
- 证据：固定 JSON 报表导入、不可变证据版本、显式选择基线与当前期。
- 比较：严格可比性校验、`cost_per_consultation` 阈值评估，已有 `comparisonResultId`。
- 缺口：
  - 没有「某次已应用变更 → 后续哪份证据」的关联；
  - 没有到期检查或未验证状态的记录；
  - 下一轮建议拿不到「上一轮假设是否得到支持」。

## 3. 目标与非目标

**目标**

- 可追溯：每个已应用变更都能找到当时的假设、验证方式与后续观察结果。
- 可解释：只陈述「指标达标 / 未达标 / 不可评估」，不把相关性说成因果。
- 人工确认：检查结果只作为下一轮建议的输入，不自动改预算或执行平台操作。

**非目标**

- 不做归因推断，不宣称「假设成立/被推翻」。
- 不为达人、内容种草发明效果指标；没有统一口径的任务明确标为「无法验证」。
- 不新增自动执行路径。

## 4. 方案比较

| 方案 | 做法 | 代价 |
| --- | --- | --- |
| A（现状） | 只保存假设与验证计划文本 | 验证永远停在计划，无法闭环 |
| B（推荐） | 接受候选时创建验证检查点；到期关联同任务、同口径的可比证据 | 新增实体、worker 任务、迁移与生命周期处理 |
| C | 自动因果推断并给出结论 | 证据不足时必然编造，违背产品原则 |

## 5. 推荐分阶段

### S1：检查点（无 worker）

接受带 `validationPlan` 的候选时，在同一事务内创建 `pending` 检查点：

- 仅当任务规则含完整度量口径（`metricKey` / 单位 / 窗口）且候选确有变更时创建；
- `dueAt = 接受时间 + rules.statWindowDays`；
- 没有完整口径则不创建，并在 UI 写明「无法验证（缺少度量口径）」，不伪造检查点；
- 幂等：同一选择重放不重复创建。

### S2：到期评估

worker 扫描到期 `pending` 检查点：

- 找同一 `taskId`、同一 `metricKey` 的最新可比证据与比较结果；
- 有可比结果：写入 `comparisonResultId` 与 `observedOutcome`（`below_threshold` / `above_threshold`），状态 `observed`；
- 证据不可比 / 缺失：状态 `inconclusive` 并记录原因，不生成「达标」结论；
- 任务版本已变更：标 `inconclusive`（`task_version_changed`），不静默删除；
- 只写检查点，不改策略、不发广告平台请求。

### S3：反馈下一轮

`PolicyEngine.propose` 的 context 增加可选只读 `openValidationChecks`，让下一轮建议可以引用「上一轮验证结果」。默认策略不使用也不影响现有实现；是否引用由具体 PolicyEngine 决定。

## 6. 数据模型草案

```
ValidationCheck {
  id, ownerId,
  taskId, taskVersion,
  sessionId, snapshotVersion,
  changeKeys: string[],            // 由变更内容规范化哈希，稳定标识
  hypothesis?, validationPlan?,
  metricKey?: "cost_per_consultation",
  dueAt,
  status: "pending" | "observed" | "inconclusive" | "cancelled",
  comparisonResultId?, evidenceRef?,
  observedOutcome?: "below_threshold" | "above_threshold" | "not_evaluable",
  reason?,                         // 例如 task_version_changed / no_comparable_evidence
  createdAt, observedAt?
}
```

存储沿用 `id + jsonb` 表模式，新增迁移与内存实现；快照已保存假设/验证文本，检查点只补充状态与证据引用。

## 7. 验收标准

**S1**

- 接受候选后原子写入检查点；重复选择/事务回滚不产生重复或孤儿检查点。
- 缺度量口径时不创建，UI 显示「无法验证」而不是空白。
- 仅 owner 可读；删除任务时随生命周期清理。

**S2**

- 无可比证据 → `inconclusive` + 原因，不生成达标结论。
- 并发到期评估只产生一条终态（幂等）。
- 结果不修改策略、不触发投递。

**S3**

- 不改变现有 PolicyEngine 的必需字段；默认策略行为不变。
- 未结检查点能出现在 context 中，且有测试证明不泄漏他人任务。

## 8. 未决问题

- 观察窗口以任务规则为准，还是解析验证计划文本？建议以规则为准，解析文本不可靠。
- 一个候选含多条变更时，建一条还是多条检查点？建议每候选一条，避免组合爆炸。
- 达人/种草没有统一指标时，是否允许人工补录观察结论？建议先不做，保持「无法验证」。
- 结果文案只用「指标达标/未达标」，是否需要用户手动确认后才进入下一轮建议？建议需要。

## 9. 关联

- 本分支：`4ad98f6`（候选假设/验证计划）、后续快照冻结提交。
- `packages/core/src/comparisons.ts`、`evidence.ts`、`investigation-alerts.ts`。
- `docs/architecture.md` 策略变更词表与证据章节。
- README「待验证的问题」。
