# VoyageAI

> 世界那么大，跟我一起去看看。

**把旅行规划从一段用完即走的 AI 回答，变成一份可确认、可编辑、可保存的旅行手账。**

VoyageAI 是一款面向中文旅行者的 AI 旅行规划 Demo。你只需要说出想去哪里、玩几天、和谁出发或想怎样调整，AI 就会结合联网信息生成建议；确认后，建议会真正写进按目的地整理的手账，而不是留在聊天记录里。

<p align="center">
  <img width="900" alt="VoyageAI 旅行手账总览" src="https://github.com/user-attachments/assets/8f3ff3a4-fb61-4cad-8e05-81c4d4171ed0" />
</p>

## 为什么是 VoyageAI？

很多 AI 旅行产品止步于“给你一段攻略”。VoyageAI 更关心攻略之后的事：

- **对话直接变成行程**：从目的地推荐、按天规划到修改现有路线，都在同一个对话入口完成。
- **先确认，再改动**：AI 会先展示变更提案；只有你确认后，才会新建或修改手账，避免好不容易整理的计划被误覆盖。
- **回答有来源，计划可落地**：支持 Web Search，并可选接入小红书只读检索；答案中的建议可以一键整理进当前行程。
- **不是聊天记录，而是一本手账**：每天的路线、必去地点、美食、住宿、价格区间和出行准备，都沉淀为可以翻阅的目的地页面。
- **AI 生成后仍由你做主**：手账可直接编辑文字、颜色、链接、图片和表格，并保存在当前浏览器中。

## 从一句话到一本旅行手账

1. **说出需求**：例如“带父母去北京 4 天，少走路”“秋天一周适合去哪里”。
2. **查看依据与提案**：AI 检索旅行信息、标注来源，并把准备执行的变更展示给你。
3. **确认并继续打磨**：确认后创建或更新手账；之后可以继续对话调整，也可以直接在页面上编辑。

## 现在可以做什么

| 场景 | 能力 |
| --- | --- |
| 探索目的地 | 根据时间、季节、同行人和偏好推荐候选目的地 |
| 生成计划 | 创建包含每日行程、景点、交通、美食、住宿和准备事项的完整手账 |
| 调整行程 | 用自然语言延长天数、增加途经点或重排行程 |
| 把回答写进行程 | AI 回答后点击“根据回答修改行程”，把新建议合并进当前手账 |
| 查证信息 | 使用 Web Search 展示来源；可选检索小红书图文笔记与酒店避雷信息 |
| 安全执行 | 新建、修改和偏好更新均经过确认门，不由模型直接写入 |
| 自由编辑 | 在手账内修改内容和文字颜色，插入链接、网络/本地图片及可编辑表格 |
| 本地保存 | AI 创建、AI 修改和手动编辑的行程保存在浏览器本地，刷新后仍可继续 |
| 多端浏览 | 支持桌面端标签、键盘方向键，以及移动端连续滚动和横向滑动 |

### 对话示例

| 你可以说 | VoyageAI 会做什么 |
| --- | --- |
| `上海` | 生成一份上海旅行计划提案，确认后创建新的目的地手账 |
| `带父母去北京 4 天，避开拥挤景点并少走路` | 结合同行人和节奏约束生成按天计划 |
| `把当前行程改为 7 天` | 基于现有内容生成完整修改方案，确认后更新当前手账 |
| `增加途经点大阪` | 在保留原计划的基础上生成途经点调整提案 |
| `这家酒店附近还有什么适合晚上去的地方？` | 联网回答并展示来源，可继续将答案写入当前行程 |

## 产品演示

| AI 变更提案 | 确认后写入行程 |
| --- | --- |
| <img width="560" alt="AI 生成旅行计划变更提案" src="https://github.com/user-attachments/assets/14139920-dd56-40f0-bc3e-3b1a5a0793c7" /> | <img width="560" alt="确认 AI 提案并更新旅行手账" src="https://github.com/user-attachments/assets/d9e932c1-2a7a-43e5-8014-b75db67dd977" /> |

## 本地体验

### 环境要求

- Node.js 18+
- 一个兼容 OpenAI Responses API 的模型服务与 API Key

### 1. 获取代码

```bash
git clone https://github.com/SylvieXYZhang/AI-travel-agent.git
cd AI-travel-agent
```

### 2. 配置模型

复制 `.env.example` 为 `.env`，至少填写：

```text
LLM_API_KEY=your-api-key
LLM_BASE_URL=https://your-provider.example.com/v1
LLM_MODEL=your-model
```

也可以不修改文件，直接在 PowerShell 中设置环境变量：

```powershell
$env:LLM_API_KEY="your-api-key"
$env:LLM_BASE_URL="https://your-provider.example.com/v1"
$env:LLM_MODEL="your-model"
```

API Key 只由本地 Node.js 服务读取，不会发送到浏览器或写入前端文件。启动后，也可以从左上角菜单进入“API 设置”，在当前服务进程中保存并测试配置。

### 3. 启动

```powershell
npm.cmd start
```

打开 <http://127.0.0.1:4173>。请通过本地服务访问；直接打开 `index.html` 无法使用 AI 问答。

## 可选：接入小红书攻略检索

项目可对接开源的 [xpzouying/xiaohongshu-mcp](https://github.com/xpzouying/xiaohongshu-mcp)（Apache-2.0），仅调用搜索和笔记详情接口，不调用发布、评论、点赞或收藏接口。

按上游说明启动服务并完成登录后，在 `.env` 中加入：

```text
XHS_SEARCH_ENABLED=true
XHS_MCP_BASE_URL=http://127.0.0.1:18060
XHS_TIMEOUT_MS=15000
XHS_DETAIL_LIMIT=3
```

当问题提到小红书，或涉及住宿/酒店时，后端会尝试读取相关图文笔记作为证据。服务未启用、登录过期或超时时，会改用公开 Web Search，并提示覆盖范围可能不完整。请在遵守平台条款、适用法律和上游项目许可的前提下使用。

## 数据与隐私

- API Key 留在本地服务端；通过设置页面提交的 Key 仅保存在当前 Node.js 进程内存中。
- 旅行手账、旅行偏好和头像保存在当前浏览器的 `localStorage` 中，不会同步到云端。
- 本地图片会写入浏览器存储；图片过大时可能触及浏览器容量限制。
- AI 的旅行建议仅供规划参考。预订、签证、开放时间、价格与交通信息请以原始来源为准。

## 当前边界

这是一个可运行的产品 Demo，而不是预订平台。目前尚未提供：

- 专用地图、地点距离和路线优化；
- 酒店实时库存、实时价格或直接预订；
- 账号系统、云端同步、分享与多人协作；
- 跨设备数据迁移和版本历史。

## 技术概览

- 原生 HTML、CSS 与 JavaScript 前端，无前端框架和构建步骤
- Node.js 静态服务与 `/api/ai/chat` 后端
- OpenAI Responses API、JSON Schema 结构化输出和 Web Search
- 可选小红书只读检索与公开搜索降级
- 服务端输入校验、响应校验、超时、请求大小限制和基础限流

<details>
<summary><strong>测试与开发命令</strong></summary>

```powershell
npm.cmd test
npm.cmd run smoke:batch -- --mock
npm.cmd run smoke:ai -- "北京出发，秋天一周，推荐三个自然风景目的地"
```

真实冒烟测试需要先配置 `LLM_API_KEY`。批量测试还支持 `--only` 和 `--json` 参数。

</details>

<details>
<summary><strong>项目结构</strong></summary>

```text
AI-travel-agent/
├── index.html                         # 手账界面与前端交互
├── server.cjs                         # 本地服务与 API 路由
├── lib/travel-ai.cjs                 # 模型、检索和结构化响应链路
├── test/                              # 自动化测试
├── scripts/                           # 冒烟测试脚本
├── documentation/issue-log.md         # 产品迭代记录
└── AI_TRAVEL_PLANNER_PRODUCT_ISSUE.md # 产品设想与验收标准
```

</details>

## 路线图

- 地图地点、距离与路线优化
- 预算与实时价格数据
- 账号、云端保存与跨设备同步
- 分享、协作与修改历史

更多背景：

- [产品迭代记录](documentation/issue-log.md)
- [完整产品设想与验收标准](AI_TRAVEL_PLANNER_PRODUCT_ISSUE.md)
