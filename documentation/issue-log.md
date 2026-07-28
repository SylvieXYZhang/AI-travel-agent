# Product Iteration Issue Log

本文件持续记录产品迭代想法、实现状态、关键决策与后续缺口。状态使用 `Implemented`、`In progress`、`Backlog`。

## AI-CHAT-001 — AI 对话驱动旅行计划变更

- Status: Implemented
- User goal: 用户通过右下角 AI 对话修改当前旅行记录，或创建新的旅行计划。
- Intent routes:
  - 修改当前记录：识别旅行周期、当前页面、调整、增删内容、途经点等关键词。
  - 新增旅行计划：识别新目的地、新建计划、安排行程等关键词。
  - 目的地推荐：识别“可以去哪里”“推荐目的地”等表达，并根据时间、季节关键词提供候选项。
- Approval rule: AI 只能生成待执行提案；修改当前记录或创建新页面前，必须由用户点击“确认执行”。取消操作不得改变页面数据。
- Response rule: AI 回复固定显示在右下角；新回复替换旧回复，页面最多保留一个回复气泡。
- Acceptance checks:
  - [x] “把当前京都行程改为 7 天”生成修改提案，不立即写入。
  - [x] “增加途经点大阪”生成当前记录修改提案。
  - [x] “计划去北海道 5 天”生成新记录提案。
  - [x] 单独输入目的地（例如“上海”）生成新记录提案，不修改当前页面。
  - [x] “一周可以去哪里”展示目的地候选项，选择后仍需二次确认。
  - [x] 确认后更新当前书页或新增目的地标签与书页。
  - [x] 新建页面以目的地命名；最新页面标签固定排在右侧最上方。
  - [x] 取消后不改变任何旅行记录。
  - [x] 新回复覆盖旧回复。
- Current limitation: 已由 AI-CHAT-002 替换为真实模型链路；刷新页面后 AI 新建或修改的行程仍不会持久化。

## AI-CHAT-001-BUG-01 — 纯目的地被误判为当前页修改

- Status: Implemented
- Observed: 输入“上海”时，系统把当前旅行页改成上海。
- Root cause: 纯目的地没有命中显式“新建/计划去”关键词，落入默认修改分支。
- Fix: 纯目的地输入默认进入新计划提案；确认后新增独立页面。动态新页面按创建时间倒序显示在右侧标签顶部。

## UI-001 — 旅行手账式主界面

- Status: Implemented
- Decision: 中央泛黄书页承载行程，左右彩色标签提供目的地快速切换。
- Interaction: 支持标签点击、上一篇/下一篇、键盘方向键与移动端横向滑动。

## MOBILE-001 — 移动端连续滚动与触控尺寸

- Status: Implemented
- Decision: 书页高度随内容自然增长，底部保留安全滚动空间；城市标签与 AI 加号使用至少 64px 的拇指友好触控尺寸。

## PROFILE-001 — 用户头像回退状态

- Status: Implemented
- Decision: 用户未上传头像时显示 `ME`；上传后使用本地存储恢复头像。

## AI-CHAT-002 — 真实模型、检索与结构化意图

- Status: Implemented
- Goal: 用真实模型返回经过 schema 校验的 `modify_current`、`create_plan`、`recommend_destinations` 意图与参数，并通过 Web Search 提供检索来源。
- Implementation: `POST /api/ai/chat` 调用 Responses API；服务端直接加载 `skills/build-travel-ai-qa` 的运行时 Prompt/Schema 契约，并注入 Web Search、超时、限流和结果校验；浏览器仅消费结构化结果。
- Guardrail: 模型输出仍不得直接写数据；服务端强制 mutation 意图需要确认，最终写入由前端确认操作执行。
- Configuration: 通过 `LLM_API_KEY`、`LLM_MODEL`、`LLM_BASE_URL` 等服务端环境变量配置，不向浏览器暴露密钥。

## DATA-001 — 旅行记录持久化与撤销

- Status: Backlog
- Goal: 保存 AI 修改历史、确认人、变更前后差异，并支持撤销最近一次操作。

## TEST-001 — AI 意图路由自动化测试

- Status: In progress
- Goal: 为关键词冲突、未知目的地、异常天数、取消操作及重复创建建立单元和交互测试。
- Implemented: 请求校验、Mock Provider、Responses API 请求形状、Web Search 来源归一化、mutation 确认门和 HTTP 端到端测试。

## AI-UI-001 — AI 对话视觉一致性

- Status: Implemented
- Decision: AI 浮动入口、展开状态和回复标题统一采用浅咖啡色，保持右下角交互区域的视觉一致性。

## README-001 — GitHub 产品主页升级

- Status: In progress
- Goal: 用中文 README 清楚解释产品定位、核心优势、使用方法、当前限制和后续方向。
- Deliverables: 桌面总览、AI 确认流程和移动端三张无隐私 Demo 截图；README 使用仓库相对路径展示。
- Guardrail: 明确当前 AI 与旅行数据均为前端模拟，不宣传尚未实现的真实模型、外部数据或云端能力。
