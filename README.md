# TS Agent：从零到英雄（TypeScript AI Agent 教程）

一套**用 TypeScript 从零手写 AI Agent** 的系统教程。不依赖 LangChain、不依赖 AI SDK 的黑盒封装——从一次最朴素的 HTTP 请求开始，逐章搭建出具备工具调用、上下文管理、记忆、多 Agent 协作、审批控制、评测与 MCP 生态接入的完整 Agent，最终做出一个迷你版 Claude Code。

## 为什么这样学

市面上的 Agent 框架把最核心的东西（Agent 循环、上下文管理、工具协议）藏在了抽象层后面。一旦遇到 agent 死循环、上下文爆炸、工具调用失败这类真实问题，框架使用者往往束手无策。

本教程反其道而行：**每一层抽象都亲手写一遍**。写完之后，你不仅会用框架，更能看懂所有框架的共同内核——因为它们的本质是同一个 `while` 循环。

## 目录

| 章节 | 主题 | 你将实现 |
|------|------|----------|
| [第 0 章](00-introduction.md) | 什么是 Agent，为什么用 TypeScript | 学习地图、环境搭建 |
| [第 1 章](01-first-llm-call.md) | 直连 LLM API | 消息结构、流式输出、abort |
| [第 2 章](02-tool-calling.md) | 工具调用（function calling） | 天气+计算器工具、结构化输出 |
| [第 3 章](03-agent-loop.md) | Agent 循环：从对话到自主干活 | 核心 `while` 循环、终止条件 |
| [第 4 章](04-tool-system.md) | 工具系统设计 | Zod 定义工具、错误自愈、安全边界 |
| [第 5 章](05-context-engineering.md) | 上下文工程 | token 预算、历史压缩、system prompt |
| [第 6 章](06-memory-and-rag.md) | 记忆与检索 | 文件记忆、embedding、mini-RAG |
| [第 7 章](07-multi-agent.md) | 多 Agent 协作 | 子 Agent、流水线、并行 fan-out |
| [第 8 章](08-control-flow.md) | 规划、审批与取消 | plan-then-execute、人工确认、可恢复会话 |
| [第 9 章](09-streaming-ui.md) | 流式解析与终端体验 | 增量工具调用、过程渲染、SSE 服务 |
| [第 10 章](10-eval-and-observability.md) | 评测与可观测性 | eval 基建、结构化日志、成本统计 |
| [第 11 章](11-mcp.md) | MCP 协议 | 写 MCP server、接入外部工具生态 |
| [第 12 章](12-capstone-mini-coding-agent.md) | 综合实战 | 迷你 Coding Agent（毕业项目） |
| [附录](appendix.md) | 术语表、陷阱清单、延伸阅读 | 速查手册 |

## 环境准备

只需要 Node.js 和一个 LLM API Key。教程代码刻意保持**零框架依赖**：用原生 `fetch` 直连 OpenAI 兼容接口，因此智谱 GLM、DeepSeek、OpenAI、Moonshot 等任何兼容服务商都能用。

```bash
# 1. Node.js 20+（自带 fetch 与 --env-file）
node -v

# 2. 建一个练习项目
mkdir ts-agent && cd ts-agent
npm init -y
npm i -D typescript tsx @types/node
npm i zod dotenv
npx tsc --init --target es2022 --module esnext --moduleResolution bundler --strict

# 3. 配置 API（.env 文件，别提交到 git）
cat > .env <<'EOF'
LLM_BASE_URL=https://open.bigmodel.cn/api/paas/v4
LLM_API_KEY=你的key
LLM_MODEL=glm-4-flash
EOF

# 4. 跑通第一章
npx tsx src/01-hello.ts
```

`.env` 换服务商只需改三行：

```bash
# OpenAI
LLM_BASE_URL=https://api.openai.com/v1        # LLM_MODEL=gpt-4o-mini
# DeepSeek
LLM_BASE_URL=https://api.deepseek.com          # LLM_MODEL=deepseek-chat
# 智谱 GLM（默认）
LLM_BASE_URL=https://open.bigmodel.cn/api/paas/v4
```

> 模型名更新很快，以你所用服务商控制台列出的为准。

## 配套代码

教程里的代码已抽成可直接运行的工程，见 [code/](code/) 目录（`npm install` 后逐章运行，[code/README.md](code/README.md) 有逐章命令表）。

## 阅读约定

- 代码采用**渐进式演进**：每章开头标注「本章新增/修改的文件」，后续章节会在前一章代码上生长，始终保持完整可运行。
- 所有代码块都可以直接复制进项目运行，命令统一用 `npx tsx`。
- 每章末尾有**练习**和**常见坑**；练习不做也能继续往下读，但做了才算真的会。
- 中文为主，关键术语保留英文原名，方便对照官方文档。

## 两条阅读路线

- **完整路线（推荐）**：按顺序读完，约 2~3 周（每天 1~2 小时）。
- **快速路线**：第 0 → 1 → 2 → 3 → 4 → 12 章，先做出能跑的东西，再回头补工程细节（5~11 章）。
