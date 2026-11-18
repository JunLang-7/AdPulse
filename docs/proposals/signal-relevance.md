# 增量设计：信号重要性与任务关联初判（问题四后半，待评审）

## 动机

#167 已让外部信息进入「未核验线索 → 人工接受/拒绝」闭环，但 README 的核心卖点是「主动识别重要性、判断信号与当前方案的关系」。本提案补上这段：模型为每条线索与本人每个活跃任务产出**初判**，用户确认后才生效；不自动建事件、不自动推送未确认结论。

## 领域对象

```ts
SignalAssessment {
  id, ownerId, leadId, taskId, taskVersion,
  importance: "high" | "medium" | "low" | "unclear",
  relation: "direct" | "indirect" | "unclear",
  explanation, quote?,            // quote 必须逐字来自线索标题
  stage: "preliminary" | "confirmed" | "rejected",
  preliminary?: { modelRef, generatedAt },
  confirmedAt?, createdAt
}
```

- `dedupKey = hash(ownerId, leadId, taskId, taskVersion)`；同一线索同一任务版本只保留一条未驳回初判。
- 只有 `confirmed` 能产生提醒；`rejected` 是终态留痕。
- 任务到期/删除后初判不可访问、不参与通知，随任务清理物理删除。

## 模型初判

- 触发：线索 persist 成功后，在同一事务内为每个活跃任务排 `prepare_signal_assessments` job（幂等 job id）。
- 输入：任务当前策略摘要（目标、人群、卖点、渠道）+ 线索标题、主题、查询词、主体声明。
- 输出：`importance`、`relation`、`explanation`（必须指出标题中与方案相关的具体部分）、`quote`（逐字摘录；摘不到留空）。
- 证据不足时必须 `unclear`，不得推测；模型不可用时 job 标记失败，不编造初判。
- 模型调用在事务外，复用个人连接的 JSON 补全出口与限流；独立 worker 未注入处理器时 job 失败留痕。

## 用户确认与提醒

- 控制台在发现线索卡片上展示初判（重要性、关系、说明、引用）与确认/驳回按钮。
- 用户确认 `high`/`medium` 且 `direct`/`indirect` 时，同事务进入 #37 日汇总批次与 #112 任务订阅筛选（新增 `signal` 输入类别）；`low`/`unclear` 仅留痕不推送。
- 发送前复检：线索不再存在、任务到期、初判被驳回/换版本，则取消旧待发。
- 线索被拒绝后不再重新初判；线索接受为 source item 不改变已确认/已驳回初判。

## 验收标准（合成数据）

| 情形 | 预期 |
| --- | --- |
| 一条线索 + 两个任务 | 两条独立初判；同任务重复 persist 不重复 |
| 模型输出无关正文 | 返回 `unclear`，不强行判定 |
| quote 不在标题中 | 丢弃 quote，不冒充摘录 |
| 初判确认（high/direct） | 状态 confirmed，进入通知队列，一条待发 |
| 初判驳回 | 终态，无提醒，可再次发现新初判（新版本/新证据） |
| low/unclear 确认 | 留痕不推送 |
| 他人线索/任务 | 404，不可访问 |
| 任务删除 | 初判随任务清理删除，待发取消 |
