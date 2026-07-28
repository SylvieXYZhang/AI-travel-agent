# 山海签 · GoLore

> 用对话创建和调整旅行计划，再用一本可以翻阅的旅行手账把它保存下来。

这是一个面向中文旅行者的 AI 旅行规划产品。用户可以通过统一的 AI 对话入口提出目的地、天数和途经点需求，查看 AI 的变更提案，并在确认后创建或修改旅行记录。

> [!IMPORTANT]
> 当前版本已接入服务端大模型问答链路：配置 API Key 后，通过 OpenAI Responses API 与 Web Search 生成结构化回答和旅行计划提案。专用酒店、地图、预算服务与云端账号仍未接入。

![旅行手账总览] <img width="1129" height="1201" alt="image" src="https://github.com/user-attachments/assets/8f3ff3a4-fb61-4cad-8e05-81c4d4171ed0" /> 

## 产品定位

传统旅行规划往往散落在攻略、地图、备忘录和聊天记录中。这个 Demo 尝试把三个步骤放进同一个界面：

1. **说出需求**：通过自然语言描述目的地、旅行天数或调整要求。
2. **确认变更**：AI 先展示准备执行的操作，用户确认后才修改数据。
3. **沉淀计划**：每个目的地形成一页旅行手账，并通过左右标签快速切换。

## 核心优势

### 对话式规划

不需要填写复杂表单。输入“上海”“把当前行程改为 7 天”或“增加途经点大阪”，Demo 会识别新建计划或修改当前计划的意图。

### 执行前确认

AI 不会直接覆盖旅行记录。新建页面或修改当前页面前，必须由用户点击“确认执行”，降低误操作风险。

### 手账式信息组织

泛黄书页承载每日行程、必去清单、路线交通、美食和准备事项；左右彩色标签用于快速切换不同目的地。

### 移动端友好

支持连续向下滚动、横向滑动切换和不小于 64 px 的主要触控目标，方便单手和拇指操作。

## 功能演示

| AI 执行确认 | 移动端体验 |
| --- | --- |
| <img width="1129" height="808" alt="image" src="https://github.com/user-attachments/assets/14139920-dd56-40f0-bc3e-3b1a5a0793c7" /><img width="1129" height="808" alt="image" src="https://github.com/user-attachments/assets/d9e932c1-2a7a-43e5-8014-b75db67dd977" />| <img width="1129" height="1201" alt="image" src="https://github.com/user-attachments/assets/8f3ff3a4-fb61-4cad-8e05-81c4d4171ed0" /> |

当前 Demo 支持：

- 点击左右城市标签切换旅行记录。
- 点击“更早的记录 / 更新的记录”顺序浏览。
- 使用键盘 `←` `→` 切换目的地。
- 在手机上横向滑动书页切换记录。
- 使用右下角 `+` 展开 AI 对话。
- 通过真实大模型问答、检索目的地信息、推荐目的地或生成计划变更提案。
- 在执行写入前确认或取消 AI 提案。
- 上传个人头像；未上传时显示 `ME`。

## 如何使用

### 1. 获取代码

```bash
git clone https://github.com/SylvieXYZhang/AI-travel-agent.git
cd AI-travel-agent
```

### 2. 启动本地服务

项目没有第三方运行时依赖，只需要 Node.js 18+。参考 `.env.example`，在服务端进程环境中设置 API Key：

```powershell
$env:LLM_API_KEY="your-api-key"
$env:LLM_BASE_URL="https://ark.cn-beijing.volces.com/api/plan/v3"
$env:LLM_MODEL="doubao-seed-2.1-turbo"
node server.cjs
```

也可以把这些变量保存在本地 `.env`；服务会自动加载该文件，且 `.gitignore` 已阻止提交。API Key 只由 `server.cjs` 读取，不会发送到浏览器或被静态服务器暴露。兼容变量 `OPENAI_API_KEY` 也可使用。`LLM_MODEL` 必须是明确模型，不支持 `Auto`。自动化测试可设置 `LLM_PROVIDER=mock`，但生产问答不会静默回退到 Mock。

### 3. 打开 Demo

访问：<http://127.0.0.1:4173>

AI 问答必须通过本地服务访问；直接打开 `index.html` 无法调用 `/api/ai/chat`。

运行测试：

```powershell
npm.cmd test
```

配置 API Key 后可执行一次真实检索问答冒烟测试：

```powershell
npm.cmd run smoke:ai -- "北京出发，秋天一周，推荐三个自然风景目的地"
```

生产问答不会在联网检索失败后降级为无检索回答；复杂问答默认允许 300 秒，达到 `LLM_TIMEOUT_MS` 后会明确返回超时。配置页轻量测试使用独立的 `LLM_TEST_TIMEOUT_MS=25000`，不会缩短正式问答。Demo 等待期间会分阶段显示需求解析、联网检索、来源核对和答案生成状态。

也可以打开左上角主菜单，点击“API 设置”进入独立配置弹窗。“保存并测试”会使用刚保存的配置执行轻量 Web Search 连通性测试，默认 25 秒超时，并反馈模型连接和检索来源状态。API Key 只保存在当前本地 Node 进程内存，不写入 HTML、浏览器存储或接口响应；服务重启后内存配置会清除并重新读取 `.env`。

若检索仍超时，可切换到更轻量的允许模型后重试完整检索：

```powershell
$env:LLM_MODEL="doubao-seed-2.0-lite"
npm.cmd run smoke:ai -- "北京出发，秋天一周，推荐三个自然风景目的地"
```

`EADDRINUSE: 4173` 表示该端口已有服务运行，不需要重复执行 `npm.cmd start`；直接访问 Demo，或先结束旧的 Node 进程后再启动。

## AI 对话示例

| 输入 | Demo 行为 |
| --- | --- |
| `上海` | 展示新建上海旅行计划的提案；确认后创建独立页面和新标签。 |
| `把当前行程改为 7 天` | 展示当前记录的周期调整提案；确认后更新每日行程。 |
| `增加途经点大阪` | 展示新增途经点提案；确认后修改当前记录。 |
| `一周可以去哪里` | 根据时间关键词展示候选目的地；选择后仍需确认创建。 |

右下角始终只保留一个 AI 回复气泡，新回复会替换旧回复。

## 当前能力与后续方向

| 能力 | 当前状态 |
| --- | --- |
| 旅行手账界面与目的地标签 | 已实现 |
| 桌面与移动端交互 | 已实现 |
| AI 意图分类和确认门 | 服务端结构化输出 + 应用确认门 |
| 按天生成行程草案 | 大模型生成，前端确认后写入 |
| 真实大模型对话 | 已接入，需配置 API Key |
| Web 旅行信息检索 | OpenAI Web Search，展示来源 |
| 小红书专用数据源 | 规划中，需合规数据接口 |
| 地图地点、距离与路线优化 | 规划中 |
| 预算和实时价格 | 后续版本 |
| 账号与云端保存 | 规划中 |

### 已知限制

- 刷新页面后，AI 新建或修改的旅行记录不会持久化。
- 未配置 `LLM_API_KEY` 时，AI 入口会明确提示服务端尚未配置，不会回退到模板回答。
- Web Search 不等同于酒店库存、地图路线或签证权威服务；重要出行信息仍需核对原始来源。
- 行程、景点、交通和餐饮信息不应直接替代真实预订与出行决策。
- 当前没有登录、分享、协作或专用实时价格/库存数据源。

## 技术说明

- 单文件 HTML、CSS 和原生 JavaScript 前端。
- Node.js 静态文件与 `/api/ai/chat` 后端服务。
- OpenAI Responses API、JSON Schema 结构化输出与 Web Search。
- 服务端响应校验、请求大小限制、超时和基础限流。
- 无前端框架、构建工具和第三方运行时依赖。
- 响应式布局覆盖桌面和移动端。

```text
AI-travel-agent/
├── index.html                         # 界面、交互和 Demo 数据
├── server.cjs                         # 本地静态服务
├── assets/                            # 本地图片资源
├── docs/images/                       # README 演示截图
├── documentation/issue-log.md         # 产品迭代记录
└── AI_TRAVEL_PLANNER_PRODUCT_ISSUE.md # 完整产品设想与验收标准
```

## 产品记录

- [产品迭代 Issue Log](documentation/issue-log.md)
- [完整产品设想与验收标准](AI_TRAVEL_PLANNER_PRODUCT_ISSUE.md)
