# 第 12 章 · 综合实战：迷你 Coding Agent（毕业项目）

> 本章修改文件：`src/lib/agent.ts`（最终整合版）
> 本章新增文件：`src/mini-agent.ts`

**本章你会做：**

- 把前 11 章的全部零件组装成一个完整程序：能读写文件、跑命令、流式显示思考过程、写操作需要你确认、长任务自动压缩上下文、Ctrl+C 保存现场、支持三种权限模式
- 一个约 300 行的迷你 Claude Code
- 一份"从 mini 到 production"的差距清单

## 12.1 最终版 `agentLoop`：所有章节的汇合点

前十一章我们分头进化了各个部件，`agentLoop` 本体还是第 3 章的样子。最终版把四样东西整合进循环：**流式调用**（第 9 章）、**安全工具执行**（第 4 章）、**上下文压缩**（第 5 章）、**统一事件流**（第 9/10 章）：

> `src/lib/agent.ts`（最终版）

```ts
import { chatStreamFull, type ChatMessage } from "./llm";
import { runToolCall, type DefinedTool, type ToolContext } from "./tools";
import { maybeCompact } from "./compact";
import type { AgentEvent } from "./events";

export interface AgentOptions {
  tools: DefinedTool<any>[];
  system?: string;
  maxTurns?: number;
  budgetTokens?: number;        // 触发压缩的上下文预算（第 5 章）
  signal?: AbortSignal;         // 一贯到底的取消（第 1/8 章）
  ctx?: ToolContext;            // confirm / signal（第 4/8 章）
  emit?: (e: AgentEvent) => void; // 统一事件流（第 9/10 章）
}

export async function agentLoop(
  input: ChatMessage[],
  opts: AgentOptions,
): Promise<{ answer: string; turns: number; stopReason: "completed" | "max_turns" | "aborted" }> {
  const messages = [...input];
  const emit = opts.emit ?? (() => {});
  let turn = 0;

  while (true) {
    turn++;
    if (turn > (opts.maxTurns ?? 25)) {
      return { answer: "达到最大步数限制。", turns: turn, stopReason: "max_turns" };
    }

    // ① 压缩检查：只压历史，不动 system（第 5 章）
    if (opts.budgetTokens) {
      const c = await maybeCompact(messages, opts.budgetTokens);
      if (c.compacted) {
        messages.splice(0, messages.length, ...c.messages);
        emit({ type: "compact", before: c.before, after: c.after });
      }
    }

    emit({ type: "turn_start", turn });

    // ② 流式调用：文本实时吐出，工具调用分片拼装（第 9 章）
    const acc = await chatStreamFull(
      messages,
      { onText: (d) => emit({ type: "text_delta", delta: d }) },
      { tools: opts.tools.map(toApiTool), signal: opts.signal },
    );

    const assistant: ChatMessage = { role: "assistant", content: acc.content || null, tool_calls: acc.toolCalls.length ? acc.toolCalls : undefined };
    messages.push(assistant);
    emit({ type: "turn_end", turn });

    // ③ 退出条件：模型不再要工具
    if (!acc.toolCalls.length) {
      return { answer: acc.content, turns: turn, stopReason: "completed" };
    }

    // ④ 安全执行每个工具（第 4 章：校验/超时/截断/错误自愈/确认）
    for (const call of acc.toolCalls) {
      const t0 = Date.now();
      emit({ type: "tool_call_start", name: call.function.name, argsPreview: call.function.arguments.slice(0, 80) });
      const result = await runToolCall(call, opts.tools, opts.ctx);
      emit({ type: "tool_result", name: call.function.name, result, ok: !result.startsWith("ERROR"), durationMs: Date.now() - t0 });
      messages.push({ role: "tool", tool_call_id: call.id, content: result });
    }
  }
}

function toApiTool(t: DefinedTool<any>) {
  return { type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } };
}
```

> `src/lib/events.ts` —— 第 9 章的事件协议正式落位：

```ts
export type AgentEvent =
  | { type: "turn_start"; turn: number }
  | { type: "text_delta"; delta: string }
  | { type: "tool_call_start"; name: string; argsPreview: string }
  | { type: "tool_result"; name: string; result: string; ok: boolean; durationMs: number }
  | { type: "compact"; before: number; after: number }
  | { type: "turn_end"; turn: number };
```

## 12.2 `mini-agent.ts`：主程序

功能清单：交互式多任务会话（一个循环干一件事，会话级多轮）、三种权限模式、写操作确认、文件与命令工具、长任务压缩、Ctrl+C 保存现场。

> `src/mini-agent.ts`

```ts
import "dotenv/config";
import * as rl from "node:readline/promises";
import { readFile, writeFile, readdir, mkdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve, sep } from "node:path";
import { z } from "zod";
import { agentLoop } from "./lib/agent";
import { defineTool, type ToolContext } from "./lib/tools";
import { AgentUI } from "./lib/ui";
import { Tracer } from "./lib/trace";
import { saveSession } from "./lib/session";
import type { PermissionMode } from "./lib/types";

const run = promisify(execFile);
const ROOT = resolve(process.cwd());
const MODE = (process.argv.find((a) => a.startsWith("--")) ?? "--ask").slice(2) as PermissionMode;
const RISKY = new Set(["write_file", "run_command"]);

// ---------- 沙箱路径（第 4 章）----------
function inProject(p: string): string {
  const abs = resolve(ROOT, p);
  if (abs !== ROOT && !abs.startsWith(ROOT + sep)) throw new Error(`路径越界：${p}`);
  return abs;
}

// ---------- 工具集（第 4 章风格，全部走 defineTool）----------
const listFiles = defineTool({
  name: "list_files",
  description: "列出项目内某目录的文件与子目录（不递归）",
  schema: z.object({ dir: z.string().default(".").describe("项目内相对路径") }),
  execute: async ({ dir }) => {
    const entries = await readdir(inProject(dir), { withFileTypes: true });
    return entries.map((e) => (e.isDirectory() ? "dir  " : "file ") + e.name).join("\n") || "(空)";
  },
});

const readFileTool = defineTool({
  name: "read_file",
  description: "读取项目内文本文件，带行号。大文件用 offset/limit 分页。",
  schema: z.object({
    path: z.string().describe("相对路径"),
    offset: z.number().int().min(1).default(1).describe("起始行"),
    limit: z.number().int().min(1).max(500).default(200).describe("最多行数"),
  }),
  execute: async ({ path, offset, limit }) => {
    const lines = (await readFile(inProject(path), "utf8")).split("\n");
    const slice = lines.slice(offset - 1, offset - 1 + limit);
    if (!slice.length) return `（文件共 ${lines.length} 行，第 ${offset} 行起无内容）`;
    return slice.map((l, i) => `${String(offset + i).padStart(5)}| ${l}`).join("\n") +
      (offset - 1 + slice.length < lines.length ? `\n（未完，共 ${lines.length} 行，用 offset=${offset + limit} 继续读）` : "");
  },
});

const writeFileTool = defineTool({
  name: "write_file",
  description: "整文件覆盖式写入（创建或替换）。禁止用于超出任务范围的文件。",
  schema: z.object({ path: z.string(), content: z.string() }),
  execute: async ({ path, content }, ctx) => {
    const abs = inProject(path);
    const old = await readFile(abs, "utf8").catch(() => "");
    const ok = await ctx.confirm?.({ action: "write_file", detail: `写入 ${path}（${old ? "修改" : "新建"}，${content.length} 字符）` }) ?? true;
    if (!ok) return "用户拒绝了此次写入，请询问用户或更换方案。";
    await writeFile(abs, content, "utf8");
    return `已写入 ${path}（${content.length} 字符）`;
  },
});

const runCommand = defineTool({
  name: "run_command",
  description: "在项目根目录执行白名单命令（测试、构建、git 查看类）。只读用途。",
  schema: z.object({
    command: z.string(),
    args: z.array(z.string()).describe("参数逐项给出，不要拼接"),
  }),
  execute: async ({ command, args }, ctx) => {
    const ALLOWED = new Set(["ls", "cat", "grep", "wc", "head", "tail", "node", "npx", "git", "npm", "tsc"]);
    if (!ALLOWED.has(command)) return `ERROR: "${command}" 不在白名单：${[...ALLOWED].join(", ")}`;
    const ok = await ctx.confirm?.({ action: "run_command", detail: `${command} ${args.join(" ")}` }) ?? true;
    if (!ok) return "用户拒绝了此命令。";
    const { stdout, stderr } = await run(command, args, { cwd: ROOT, timeout: 30_000, maxBuffer: 1_000_000, signal: ctx.signal });
    return ((stdout + stderr).trim() || "(无输出)").slice(0, 4000);
  },
});

const tools = [listFiles, readFileTool, writeFileTool, runCommand];

// ---------- 组装 ----------
const ui = new AgentUI();
const controller = new AbortController();
process.on("SIGINT", () => {
  if (controller.signal.aborted) { console.error("\n强制退出"); process.exit(130); }
  controller.abort(new Error("用户中断"));
  console.error("\n取消中…（再按一次强制退出）");
});

const SYSTEM =
  `你是本项目的编程助手（mini coding agent）。\n\n` +
  `# 工作方式\n` +
  `- 动手前先 list_files / read_file 了解现状，禁止凭想象修改未读过的文件\n` +
  `- 修改代码后用 run_command 验证（如 npx tsx <file> 或 npm test）\n` +
  `- 一次任务只解决一个问题，结束时汇报：改动文件、验证结果、遗留风险\n\n` +
  `# 约束\n- 只操作项目目录内的文件；不改测试来让测试通过\n` +
  `- write_file 是整文件覆盖：改动现有文件前必须先 read_file 拿到全文`;

// 交互式会话：一次 agentLoop 干一件事，会话级可连续多件事
const stdin = rl.createInterface({ input: process.stdin, output: process.stdout });

async function main() {
  console.log(`mini-agent 就绪 [模式: ${MODE}]。输入任务，空行取消，Ctrl+C 中断当前任务。\n`);
  while (true) {
    const task = (await stdin.question("> ")).trim();
    if (!task) continue;
    if (["exit", "quit", "q"].includes(task.toLowerCase())) break;

    const tracer = await Tracer.start({ mode: MODE, task });
    const ctx: ToolContext = {
      signal: controller.signal,
      confirm: async ({ action, detail }) => {
        if (MODE === "yolo" || !RISKY.has(action)) return MODE !== "readonly";
        if (MODE === "readonly") return false;
        const ans = (await stdin.question(`  ⚠ ${action}: ${detail} [y/N] `)).trim().toLowerCase();
        return ans === "y";
      },
    };

    try {
      const result = await agentLoop(
        [{ role: "system", content: SYSTEM }, { role: "user", content: task }],
        {
          tools, maxTurns: 30, budgetTokens: 24_000, signal: controller.signal, ctx,
          emit: (e) => {
            tracer.write({ ...e, ts: Date.now() }).catch(() => {});
            if (e.type === "text_delta") ui.onText(e.delta);
            if (e.type === "tool_call_start") { ui.endText(); ui.onToolStart(e.name, e.argsPreview); }
            if (e.type === "tool_result") ui.onToolResult(e.name, e.result);
            if (e.type === "compact") ui.system(`上下文已压缩 ${e.before} → ${e.after} tokens`);
          },
        },
      );
      ui.endText();
      console.log(`\n${result.stopReason === "completed" ? "✅" : "⚠️ "} ${result.answer}（${result.turns} 轮，累计 ${Math.round(tracer.tokens)} tokens）\n`);
    } catch (e) {
      ui.endText();
      if (controller.signal.aborted) {
        console.error("已中断。");
      } else {
        console.error(`出错：${(e as Error).message}`);
      }
    }
  }
  stdin.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
```

> 代码依赖提示：`PermissionMode` 放进 `src/lib/types.ts`（第 8 章）；`confirm` 签名返回 `Promise<boolean>`（第 4 章）；`run_command` 与 `write_file` 里省略了 `import`，按 4.4 补全。

## 12.3 跑起来

```bash
npx tsx src/mini-agent.ts --ask
```

三个毕业验收任务，由易到难覆盖全部机制：

1. **只读调研**：`"这个项目里哪个文件最长？主要写了什么？"` —— 应看到 list/read 工具链、流式输出、`readonly` 模式下写工具被拒。
2. **带确认的写**：`"写一个 fizzbuzz.ts 并运行验证"` —— 应看到 write_file 前弹出确认（y 放行）、run_command 白名单校验、执行验证、最终汇报。
3. **长任务压缩**：准备一个 20+ 文件的目录，`"逐个总结 src 下所有文件的功能并输出汇总"` —— 观察到 compact 事件触发、任务不跑偏（这是第 5 章的考试）。

每跑一次，`traces/` 里多一份可回放记录；有失败，先看 trace 再改代码——第 10 章的工作流，从今天起成为你的默认习惯。

## 12.4 从 mini 到 production 的差距清单

诚实地说，mini-agent 与真实产品之间还隔着这些工程（按投入产出排序），每一条都是你下一阶段的学习地图：

| 差距 | 说明 | 对应方向 |
|------|------|----------|
| 沙箱执行 | 命令跑在你本机用户权限下；生产要求容器/VM 级隔离、文件系统快照回滚 | 容器化、沙箱 |
| 并发与多会话 | 单进程单会话；生产要会话隔离、排队、并发预算 | 服务化 |
| 重试与降级 | 限流/超时的重试很粗糙；生产要分层退避、模型降级、断点续跑 | 可靠性工程 |
| 上下文精细管理 | 压缩策略单一；生产要做工具结果分级缓存、选择性重放 | 上下文工程深化 |
| 评测覆盖 | 只有手写用例；生产要有回归门禁、A/B、线上抽样 judge | 第 10 章扩展 |
| 安全审计 | confirm 是终端问答；生产要审批日志、权限持久化、注入防御测试 | 第 8/11 章扩展 |
| 前端 | 终端 UI；生产是 Web UI + SSE（第 9 章已埋好协议） | 产品化 |

## 12.5 结语：你已经知道了什么

回头看第 0 章那句话：**Agent = LLM + 工具 + 循环**。十二个章节之后，每个词你都有了肌肉记忆：

- **LLM** 不只是"调一下 API"：消息结构、流式协议、token 经济、上下文窗口的行为学（第 1、5 章）。
- **工具** 不只是"函数暴露"：schema 即 prompt、错误信息即引导、安全即分层（第 2、4、11 章）。
- **循环** 不只是 `while(true)`：终止条件、状态管理、人机控制权、事件流（第 3、7、8、9 章）。

以及贯穿始终的一件事：**Agent 工程的本质是上下文工程**。给模型看的每一段文字——system prompt、工具描述、压缩摘要、错误消息——都是代码。写它们要像写代码一样严谨，像写文档一样体贴。

去把第 0 章练习里写下的那个真实任务做出来吧。那才是这本教程真正的毕业典礼。

---

上一章：[第 11 章](11-mcp.md) · [附录](appendix.md)
