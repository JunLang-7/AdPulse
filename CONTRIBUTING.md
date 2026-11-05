# 开发约定

本文件只补充 AdPulse 的项目约束；工程流程遵循 [XEngineer 规范](https://github.com/1024XEngineer/XEngineer.wiki)。环境与操作见 [开发指南](docs/development.md)，模块职责与现有限制见 [实现导览](docs/architecture.md)。AI 执行入口见 [AGENTS.md](AGENTS.md)。

## 1. 先澄清，再提交

- 开始前阅读对应 Issue、依赖和验收标准。待评审提案或尚未澄清的契约不能直接进入功能开发；发现范围变化，先补增量 Issue。
- 工程设计由 Issue 承载，进入开发即定稿只读；变更新写说明，不覆盖历史。README、使用文档和当前实现导览随代码维护，不作为设计定稿。
- 所有改动经 Issue 驱动的小 PR，不直接推 main。一个 PR 解决一个明确问题；设计/原型草案 PR 只用于评审，不合并，定稿回填 Issue。
- 不夹带无关重构、依赖升级或全库格式化。改动超出原验收范围时先拆任务；不因方便而放宽类型、校验或测试。

## 2. 模块与契约边界

- core 承载领域规则、端口与用例，不引入 HTTP、平台协议、数据库驱动或前端依赖。
- channels 只做出入站薄适配；storage 实现存储端口；runtime 负责装配。不能在 core 按飞书等平台分支处理业务，也不建设通用机器人框架。
- API 在边界做输入校验，领域层仍检查权限、期限、版本和策略变更。事务回调可重试，禁止其中执行网络 I/O 或不可回滚副作用。
- REST 契约以 `contracts/openapi.json` 为准。改 API 时同步校验、OpenAPI、生成类型与测试；先运行 `bun run sdk:generate`，不得手改生成文件或用类型断言掩盖漂移。
- 控制台通过 `apps/console/src/adpulse-client.ts` 的类型化客户端调用 API，不另写一套 HTTP 契约、不直接引用后端领域源码。UI 复用组件，不复制模板业务或添加未实现的占位导航。
- 依赖边界由 `tests/boundaries.test.ts` 辅助检查；检查通过不代替对跨模块调用的 Review。

## 3. 运行、依赖与数据

- Bun 1.4.4 只负责依赖、workspace 和脚本入口；Node.js 24+ 运行 API、worker、测试与 SDK 校验，CI 使用 Node.js 24。不要用 `bun --bun` 切换服务运行时。
- 只维护 `bun.lock`；复现安装用 `bun install --frozen-lockfile`。新增依赖须说明必要性并提交锁文件，不依赖本机残留包；不顺带引入 Redis、ORM、微服务或大型框架。
- 生产源码与测试使用 TypeScript。`tests/*.test.ts` 由 Node 直接剔除类型运行，只使用可擦除语法；测试类型检查仍须执行，不能把“能运行”当成“类型正确”。
- PostgreSQL 用于持久化与集成测试，内存仅供演示/测试。拆分 API 与 worker 时必须共享数据库；结构变更先明确兼容与迁移方案，`CREATE IF NOT EXISTS` 不等于版本迁移。

## 4. 验证门槛

从仓库根目录执行现有检查，不另起一套工具链：

```bash
bun install --frozen-lockfile
bun run typecheck
bun run build
bun run test
bun run sdk:check
bun run --cwd apps/console typecheck
bun run --cwd apps/console build
```

- 修 bug 应补能复现问题的回归测试；核心规则覆盖正常、边界、拒绝与恢复。涉及事务、并发或存储时，运行专用 PostgreSQL 集成测试，不能只用内存结果验收。
- `TEST_DATABASE_URL` 只能指向专用可丢弃测试库；配置与启动方式见开发指南。未配置时如实报告 SKIP，不称“全部集成测试通过”；CI 应运行该项。
- UI 行为变更应补适用的组件/端到端测试，并记录操作路径与预期结果；当前缺少合适设施时，在 Issue 明确补测方案和缺口，不把截图、模块 HTTP 200 或构建成功当作行为测试。
- 后端构建不能代替控制台类型检查与 Vite 构建。不通过的检查须解决后再验收；未执行的检查必须披露原因。

## 5. 安全与产品边界

- 不提交密钥、`.env`、个人信息或未脱敏的真实数据；示例/测试用合成数据。Vite token 会进入浏览器和静态产物，只供受控开发，不是公开部署的认证方案。
- 策略仅是内部草案，变更必须人工确认；不自动操作广告平台，不绕过冻结候选、授权与变更限制，不编造预算、证据或效果结论。
- ACK/HTTP 202 仅表示可靠接收，不表示业务生效；业务结果与消息投递结果分开。不得承诺跨平台端到端 exactly-once。
- 区分“拟实现、已实现、本地验证、CI 验证、真实平台验收”。mock/合成协议测试不能替代真机证据；平台适配和采集能力未完成前不得标为可用。

## 6. PR 与交接

- Commit 使用清晰的 `feat:` / `fix:` / `docs:` / `test:` / `refactor:` / `chore:` 等前缀，说明做了什么；不为此增加强制提交工具。
- PR 写清关联 Issue、问题与改动范围、实际验证命令/结果（含跳过项）、兼容性与剩余限制。AI 参与时附关键指令摘要与 Review 情况，不伪造人工 Review。
- 合并前 CI 必须通过，Review 意见已处理并经人工 Review。自动检查不替代人的判断；作者须能讲清改动。
- 未获明确授权不合并 PR、关闭他人任务或追认提案已接受；收尾说明已交付什么、哪些仍待评审/验证。
