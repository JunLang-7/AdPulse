# Proposal：投放方式类型与分口径效果衡量（路线 B 实施计划，草案待评审）

## 0. 决策记录

- 前稿列出三条路线：A（收口承诺）、B（显式建模类型 + 各自口径）、C（只加类型标签）。
- **已选定路线 B**。本文件是 B 的完整实施计划，评审通过前不进入功能开发。
- 关联 Issue：待填编号（本轮审计发现第 5 条）。

## 1. 目标

让系统真正区分三种投放方式，并用各自的口径衡量效果，兑现 README 这句承诺：

> 「两者可以围绕同一推广目标作出投入选择，但不能强行使用同一种效果衡量方式。能计算的计算，能比较的比较，无法归因或数据不完整的部分应明确保留。」

落地为三点：

1. **投放方式类型**成为一等概念：`paid_ads`（平台付费广告）、`influencer`（达人合作）、`seeding`（内容种草）。
2. **效果证据**按类型分口径：付费广告沿用现有指标，达人/种草有自己的指标，互不混算。
3. **策略变更**按类型校验：付费广告特有的旋钮（出价）不会错误应用到达人/种草。

## 2. 核心设计（数据模型方向）

> 下面是设计方向，用于定稿评审；具体类型签名在各自 Issue 里定稿，不在此处写死实现。

### 2.1 投放方式类型

```text
PlacementType = "paid_ads" | "influencer" | "seeding"
```

### 2.2 策略模型（Strategy.channels）

给每个渠道加一个 `type` 字段（旧数据缺省视为 `paid_ads`，向后兼容）：

| type | 渠道旋钮 |
| --- | --- |
| `paid_ads` | `budget`（预算）、`bidCpc`（出价）、`enabled`（开关） |
| `influencer` | `budget`（合作费预算）、`enabled` |
| `seeding` | `budget`（内容预算）、`enabled` |

规则：`bidCpc` 仅 `paid_ads` 合法；`budget` 与 `enabled` 三类通用。`budget` 统一理解为「投入预算」，避免为三种类型各造一套近义词。

### 2.3 效果证据模型（Evidence）

给证据记录加 `placementType`（旧数据缺省 `paid_ads`）。指标按类型分口径：

| type | 投入指标 | 结果指标 | 派生指标（可设阈值） |
| --- | --- | --- | --- |
| `paid_ads` | `spendMinor`（花费） | `consultations`（咨询） | `cost_per_consultation`（单次咨询成本） |
| `influencer` | `feeMinor`（合作费） | `posts`（发布条数）、`engagement`（互动量）、`impressions`（曝光） | `cost_per_engagement`（单次互动成本） |
| `seeding` | `contentCostMinor`（内容成本） | `posts`、`engagement`、`impressions` | `cost_per_engagement` |

**重要边界：** 达人/种草的 `impressions`、`engagement` 这类指标**不可归因到成交**，不能强行换算成咨询成本。系统只做「能计算的比较」，并沿用现有 `attribution` 字段把归因口径和局限保留下来。指标集是**探索假设**，集中定义在一处 registry，便于访谈后增减，不在各处散落硬编码。

### 2.4 策略变更词表（StrategyChange）

渠道类变更按 `type` 校验：

- `budget` / `enabled`：三类通用（沿用现有 `from` 过期检查与 `Limits` 比例限幅）。
- `bidCpc`：仅 `paid_ads`，对 `influencer` / `seeding` 直接拒绝，不静默降级。
- `isMonetaryChange()` 口径扩展为「投入预算类变更」，三类都算花钱。

**不在本期**：达人清单（合作对象）的增删、内容方向建模——它们是独立缺口，另开 Issue，不与「效果衡量」混在一起。

## 3. 分阶段实施

每阶段一个可独立评审、独立合并的小 PR（遵循 CONTRIBUTING 的「一个 PR 一个明确问题」）。阶段 2 起依赖阶段 1。

### 阶段 1：投放方式类型进入策略与证据模型（数据层 + 校验 + 契约）

**改动：**
- `packages/core/src/domain/strategy.ts`：新增 `PlacementType`；`channels` 值加 `type?`；`validateStrategy` 校验 `type` 合法、`bidCpc` 仅 `paid_ads`。
- `packages/core/src/state/model.ts`：`Evidence` 系列加 `placementType?`，缺省 `paid_ads`。
- `apps/api/src/routes/admin.ts`：`strategy` zod schema 与证据 zod schema 加 `type` / `placementType`（可选、枚举校验）。
- `contracts/openapi.json` + `bun run sdk:generate`：同步 schema 与生成类型。
- 存储：策略与证据均为 JSONB，字段加法式，**无需 DDL 迁移**；读取时缺省归一为 `paid_ads`。

**测试：** `tests/validation.test.ts` 等补：旧数据缺 `type` 读作 `paid_ads`；非法 `type` 拒绝；`bidCpc` 出现在达人渠道被拒绝。

**验收：** 老数据原样可读、语义不变；新数据能携带类型；非法值在边界被拒。跑通 `bun run typecheck / build / test / sdk:check`。

### 阶段 2：达人/种草效果指标与分口径比较

**改动：**
- `packages/core/src/state/model.ts`：`metricsContract`、`values` 扩展新增指标；`ComparisonMetric`、`metricKey`、`task.rules` 阈值字段扩展。
- 新增指标 registry（如 `packages/core/src/domain/metrics.ts`）：集中定义各类型的指标键、定义、公式与「是否可归因」标记。
- `packages/core/src/comparisons.ts`、`comparison-service.ts`：比较与阈值判定按 `placementType` 选择正确指标，严格可比性校验保持不变（口径不一致即拒绝比较）。
- `packages/core/src/tasks.ts`、`orchestrator.ts`、`investigation-alerts.ts`：任务规则与告警按新 `metricKey` 校验与展示。
- `apps/api/src/routes/admin.ts`：证据导入 zod 接受新指标字段。
- `contracts/openapi.json` + `sdk:generate`。

**测试：** 每种新指标的正常、边界、拒绝、口径不一致拒绝比较；付费广告路径回归不动。

**验收：** 达人/种草证据能导入、能按各自口径比较；口径不一致时不产生结论；付费广告行为不变。

### 阶段 3：控制台——渠道类型选择 + 达人/种草效果录入与展示

**改动：**
- `apps/console/src/views/adpulse/tasks/editor.tsx`：渠道编辑加「投放方式」下拉；按类型显示对应旋钮（出价仅付费广告显示）。
- `apps/console/src/views/adpulse/tasks/evidence-file.ts`、`evidence-panel.tsx`、`comparison-panel.tsx`、`investigation-alerts-panel.tsx`：按类型渲染新指标与归因局限说明。
- `apps/console/src/generated/api.d.ts`：随 `sdk:generate` 更新。

**测试：** 组件测试覆盖三类渠道的创建、指标展示、出价字段的显隐。

**验收：** 控制台能创建达人/种草渠道、录入并回看其效果；出价不出现于达人/种草；`bun run --cwd apps/console typecheck / build` 通过。

### 阶段 4：AI 草稿抽取——建议投放方式

**改动：**
- `packages/runtime/src/task-draft-extractor.ts`：`channels` 阶段提示词与解析增加「投放方式」建议，标注为待核对建议，不直接改写表单。
- 相关测试 `tests/task-draft-extractor.test.ts`。

**验收：** 草稿能给出「付费广告 / 达人 / 种草」建议并标待核对；不编造合作对象或效果数字。

### 阶段 5：文档收口

- `README.md` §投放范围与效果边界、§能力边界：从「待建模」改为「已建模」，说明类型与分口径。
- `docs/architecture.md`：策略变更词表、指标 registry、证据模型说明同步。
- 更新本提案状态为「已实现（阶段 N）」，保留历史决策记录。

## 4. 全量涉及文件清单

| 层 | 文件 |
| --- | --- |
| core | `domain/strategy.ts`、`state/model.ts`、`comparisons.ts`、`comparison-service.ts`、`tasks.ts`、`orchestrator.ts`、`investigation-alerts.ts`、新增 `domain/metrics.ts` |
| api | `apps/api/src/routes/admin.ts` |
| 契约 | `contracts/openapi.json`（经 `sdk:generate` 生成 `apps/console/src/generated/api.d.ts`） |
| console | `tasks/editor.tsx`、`tasks/evidence-file.ts`、`tasks/evidence-panel.tsx`、`tasks/comparison-panel.tsx`、`tasks/investigation-alerts-panel.tsx` |
| runtime | `task-draft-extractor.ts` |
| 测试 | `tests/validation.test.ts`、`tests/task-draft-extractor.test.ts`、`apps/console/test/*`（对应组件） |
| 文档 | `README.md`、`docs/architecture.md` |

## 5. 风险与开放问题

1. **指标集是假设**：达人/种草该衡量什么目前没有访谈证据。本计划先把指标集中进 registry、标注为「探索假设」，避免散落；访谈后可增减而不伤结构。
2. **归因边界**：曝光/互动不等于成交。系统必须沿用「能计算的计算、不可归因的保留」，不能把互动换算成咨询。
3. **兼容性**：策略/证据是 JSONB 加法式字段，无需迁移；但要守住「旧数据缺省 paid_ads」的读取归一，避免老任务被误判。
4. **范围膨胀风险**：达人清单（合作对象）、内容方向是独立缺口，必须另开 Issue，不塞进本计划。
5. **工作量**：跨 core/api/契约/控制台/runtime 五层，须按 5 个阶段小 PR 推进，禁止一次大改。

## 6. 验收标准（总）

- 三种投放方式在策略、证据、变更词表中都能被表达和校验。
- 达人/种草的效果证据按各自口径导入与比较，付费广告指标不混入。
- 口径不一致（指标、范围、归因、币种等）时拒绝比较，不产出结论。
- 达人/种草的曝光/互动等不可归因指标被明确标注，不换算成咨询成本。
- 旧数据读作 `paid_ads`，行为不变；全量检查（`typecheck / build / test / sdk:check / console typecheck / console build`）通过。

## 7. 不包含

- 达人清单（合作对象）与内容方向的建模（独立 Issue）。
- 任何自动投放、平台操作或收益承诺。
- 未经验证就固化的指标集——指标以 registry 形式可调整。

---

# 附：实现说明（开发期增补，不改动上方计划正文）

本节记录路线 B 的实际落地情况，属于新增说明，不覆盖已定稿的计划正文。

## A. 落点与正文的差异

| 计划正文写法 | 实际实现 | 原因 |
| --- | --- | --- |
| 新增 `domain/metrics.ts` | 新增 `domain/placement.ts`，类型、指标键、标签与归因局限集中在这里 | 一个文件就能管住「哪种投放方式用哪组指标」，少一层间接 |
| 比较输出按类型分结构 | 比较输出的字段名沿用历史契约，另加 `placementType` 与 `metricKeys` 元信息 | 不破坏既有前端、告警与快照；展示层按口径标注真实名称，用户不会看到误导字段名 |
| 证据键集合严格等于两个键 | 只允许「本口径的键」，允许缺一个键或值为空 | 证据本来就允许「值缺失 / 来源为空」，比较引擎会给出待补证原因；导入时不应编造数值 |
| 任务规则按新 metricKey 扩展 | 任务规则新增 `placementType`，一个任务只用一套告警口径 | 避免同一任务里把互动量和咨询次数混在一起算 |
| AI 草稿建议投放方式 | 产出 `placementTypes` 建议，只作为待核对的参考提示，不写入表单 | 材料里的说法不等于已确定的投放安排 |

## B. 实际改了什么

- 内核：`domain/placement.ts`、`domain/strategy.ts`、`state/model.ts`、`comparisons.ts`、`comparison-service.ts`、`tasks.ts`、`investigation-alerts.ts`、`evidence.ts`。
- API 与契约：`apps/api/src/routes/admin.ts`、`contracts/openapi.json`，并执行 `sdk:generate` 更新生成类型。
- 控制台：`task-form.ts`、`editor.tsx`、`evidence-file.ts`、`evidence-panel.tsx`、`comparison-panel.tsx`、`investigation-alerts-panel.tsx`、`review-display.ts`、`task-setup-guide.tsx`，新增 `placement-display.ts`。
- 草稿：`packages/runtime/src/task-draft-extractor.ts`。
- 测试：新增 `tests/placement.test.ts`（12 项）、`tests/placement-draft.test.ts`（2 项）；补充 `tests/console-task-form.test.ts`、`apps/console/test/task-editor-page.test.tsx`。
- 文档：`README.md`、`docs/architecture.md`、本提案附录。

## C. 三种口径

| 投放方式 | 投入 | 结果 | 派生成本 | 出价旋钮 |
| --- | --- | --- | --- | --- |
| 付费广告 `paid_ads` | `spendMinor` 投放花费 | `consultations` 咨询次数 | `cost_per_consultation` | 有 |
| 达人合作 `influencer` | `feeMinor` 合作费用 | `engagement` 互动量 | `cost_per_engagement` | 无 |
| 内容种草 `seeding` | `contentCostMinor` 内容成本 | `engagement` 互动量 | `cost_per_engagement` | 无 |

不同口径的键不能混进同一份证据；两期证据投放方式不同时判为不可比；任务规则口径与证据不一致时不产出阈值结论。归因局限随比较结果与提醒一起展示。

## D. 兼容性

策略渠道与效果证据都是 JSONB 加法式字段，不需要数据库迁移。旧数据没有 `placementType`，读取时一律按 `paid_ads` 处理，行为不变。比较结果新增的元信息字段为可选，旧结果仍可读。

## E. 实际验证

- `bun run typecheck`、`bun run build`、控制台 `typecheck` / `build` 通过（全量强制重编译核验）。
- 本地最终基线 `bun run test`：Node 624 项，592 通过、0 失败、32 跳过；组件 67 项全过。跳过的都是未配置 `TEST_DATABASE_URL` 的 PostgreSQL 集成测试，未冒称通过。
- `bun run sdk:check` 通过；基线原有的 SDK drift 已由本次契约与生成类型同步修好。
- CI（GitHub Actions「Build and Test」，带 PostgreSQL 16，最终 run `44336786977`）：`verify` 与 GitGuardian 均 pass；Node **624 项 624 通过、0 跳过**，组件 67 项全过。本地跳过的集成测试由 CI 补跑且通过。
- 附带修复：同步 main 时发现 #161 新增数据库迁移 17，却未同步 3 处测试的版本断言（main 自身 CI 当时为红）；本分支将断言与代码事实对齐，属测试期望值修正，不改产品逻辑。
- 未执行：真实广告平台 / 达人平台联调、真实报表导入验收、人工 Review。

## F. 剩余限制（不可当作已完成）

1. **指标集仍是假设**：达人 / 种草看合作费、内容成本、互动量是否合适，需真实用户与报表验证；registry 便于后续调整，但不代表口径已验证。
2. **一个任务一套口径**：同一推广任务下同时做付费广告和达人合作时，告警只能选一套口径；另一套口径的效果需另开任务查看。
3. **不可归因部分只保留、不推断**：互动量不等于成交，系统不做成交归因，也不承诺收益。
4. **合作对象与内容方向仍未建模**：它们是独立缺口，需另开 Issue。
5. **提案状态仍为待评审**：本附录只记录实现，不代表提案已获接受；关联 Issue 见 [#157](https://github.com/JunLang-7/AdPulse/issues/157)。
6. **基线**：本分支已同步 `origin/main`（含 #154 / #161）并解决与已合并改动的重叠（`task-setup-guide.tsx` 改用新版建议机制）；本地主工作区另有未提交改动，合并顺序仍由人工确认。
