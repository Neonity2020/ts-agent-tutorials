# 配套代码（《TS Agent：从零到英雄》）

教程正文的代码已经**抽成可直接运行的工程**。与教程唯一的差别：`src/lib/` 是各章代码演进到最终形态的整合版（例如 `agentLoop` 用的是第 12 章定稿版：`emit` 事件流 + 安全工具执行 + 自动压缩），教程中间章节展示的是当时的演化中间态，逻辑一致。

## 安装

```bash
cd code
npm install
cp .env.example .env   # 填入你的 LLM_API_KEY
```

## 逐章运行

| 章 | 示例 | 命令 | 说明 |
|----|------|------|------|
| 1 | 最基础调用 | `npx tsx src/demos/01-hello.ts` | messages / usage |
| 1 | 流式输出 | `npx tsx src/demos/01-stream.ts` | SSE 解析、打字机效果 |
| 2 | 一轮工具调用 | `npx tsx src/demos/02-weather.ts` | 手工 JSON Schema，观察"模型想调" |
| 2 | 结构化输出 | `npx tsx src/demos/02-extract.ts` | Zod schema 逼模型按结构产出 |
| 3 | Agent 循环 | `npx tsx src/demos/03-files.ts` | 文件统计任务，观察自主多步 |
| 4 | 工具系统 | `npx tsx src/demos/04-safe-tools.ts [任务] [--yolo]` | defineTool/沙箱/白名单/确认 |
| 5 | 上下文审计 | `npx tsx src/demos/05-audit.ts` | 打印模型看到的上下文构成 |
| 6 | 长期记忆 | `npx tsx src/demos/06-memory.ts` | remember 工具 + MEMORY.md |
| 7 | 多 Agent | `npx tsx src/demos/07-research-team.ts` | spawn 子 Agent（搜索为 MOCK） |
| 8 | 计划+审批 | `npx tsx src/demos/08-plan-execute.ts` | 交互式；Ctrl+C 保存会话 |
| 9 | 终端 UI | `npx tsx src/demos/09-tui.ts [--yolo]` | 流式渲染 + spinner |
| 9 | SSE 服务 | `npx tsx src/demos/09-sse-server.ts` | 另开终端：`curl -N -X POST localhost:8080/agent -d '{"task":"看看 notes 里有什么"}'` |
| 10 | Eval | `npx tsx evals/run.ts [caseId]` | 数据集 runner + 报告；`evals/judge.ts` 是 LLM-as-judge |
| 11 | MCP | `npx tsx src/demos/11-mcp-bridge.ts` | 桥接 `src/mcp/word-count-server.ts` |
| 12 | 毕业项目 | `npx tsx src/mini-agent.ts [--readonly\|--ask\|--yolo]` | 迷你 Coding Agent（交互式） |

## 文件地图

```
src/
  lib/
    llm.ts        # 第 1/9 章  chat / chatStream / chatStreamFull / token 估算
    events.ts     # 第 9 章   AgentEvent 事件协议
    tools.ts      # 第 2/4 章 defineTool / runToolCall（校验·超时·截断·错误自愈）
    agent.ts      # 第 3/12 章 agentLoop 最终整合版
    compact.ts    # 第 5 章   maybeCompact 历史压缩
    audit.ts      # 第 5 章   auditContext 上下文审计
    memory.ts     # 第 6 章   文件记忆 + remember/update_memory 工具
    rag.ts        # 第 6 章   embedding + 余弦相似度 mini-RAG
    subagent.ts   # 第 7 章   spawn 工具工厂 + 并发池
    approval.ts   # 第 8 章   makeConfirm 权限确认
    session.ts    # 第 8 章   saveSession / loadSession
    ui.ts         # 第 9 章   AgentUI 终端渲染（含 spinner）
    trace.ts      # 第 10 章  Tracer（JSONL 事件落盘）
    types.ts      # 第 8 章   PermissionMode
    mcp.ts        # 第 11 章  connectMcpBridge（带 close）/ connectMcpTools 桥接
  demos/          # 上面表格里的逐章示例（shared.ts 是共用的基础工具集）
  mcp/            # 第 11 章  示例 MCP server
  mini-agent.ts   # 第 12 章  毕业项目
evals/            # 第 10 章  cases.jsonl / run.ts / judge.ts
```

## 注意

- 所有 demo 需要能联网访问你配置的 LLM 服务商；运行时产生的 `traces/`、`.agent-sessions/`、`notes/`、`memory/`、`evals/runs/` 均已 gitignore。
- `07-research-team.ts` 的 `web_search` 是固定 MOCK 数据（不烧钱）；接真实搜索 API 时替换其 execute 即可。
- `rag.ts` 刻意没有 demo——embedding 调用是真实计费，按第 6 章教程自己搭索引玩。
- 类型检查：`npm run typecheck`。
