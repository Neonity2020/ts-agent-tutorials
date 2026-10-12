# 第 3 章 · Agent 循环：从"一次对话"到"自主干活"

> 本章新增文件：`src/lib/agent.ts`、`src/demos/03-files.ts`

**本章你会学会：**

- 写出那个著名的十行循环——所有 Agent 框架的共同内核
- 三种退出条件：完成、失败、超限
- 观察一次完整的 Agent 决策轨迹

## 3.1 第 2 章缺了什么

上一章我们跑通了"一轮"工具调用：请求 → tool_calls → 执行 → 回填 → 续答。但它是**写死的单轮**。真实的任务往往需要连环调用：

> "统计一下 `./notes` 目录下所有 markdown 文件的总字数"

模型需要：列目录 → 发现 3 个文件 → 读第 1 个 → 读第 2 个 → 读第 3 个 → 计算汇总 → 回答。每一步依赖上一步的结果，**无法预知要走几步**。

把"单轮"改成"循环"，让模型自己决定"要不要继续调工具"，Agent 就诞生了：

```ts
while (true) {
  const reply = await chat(messages, { tools });
  messages.push(reply.message);
  if (!reply.message.tool_calls?.length) break;   // 模型不再要工具 = 任务完成
  await executeAll(reply.message.tool_calls);       // 执行并回填，进入下一轮
}
```

这就是 Agent 循环的全部骨架。剩下的章节都在给这个骨架长肉。

## 3.2 `agentLoop()`：最小可用实现

> `src/lib/agent.ts`

```ts
import { chat, type ChatMessage, type ToolCall } from "./llm";

export interface Tool {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema
  execute: (args: unknown) => Promise<string>;
}

export interface AgentOptions {
  tools?: Tool[];
  system?: string;
  maxTurns?: number;        // 防失控的保险丝，见 3.3
  onStep?: (step: StepInfo) => void;  // 观察决策轨迹
}

export interface StepInfo {
  turn: number;
  assistant: ChatMessage;
  toolResults?: { name: string; result: string }[];
}

export interface AgentResult {
  answer: string;
  turns: number;
  stopReason: "completed" | "max_turns" | "error";
}

export async function agentLoop(
  messages: ChatMessage[],
  opts: AgentOptions = {},
): Promise<AgentResult> {
  const { tools = [], maxTurns = 25, onStep } = opts;
  if (opts.system) {
    messages = [{ role: "system", content: opts.system }, ...messages];
  }

  const apiTools = tools.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));

  let turn = 0;
  while (true) {
    turn++;
    if (turn > maxTurns) {
      return { answer: "达到最大步数限制，任务中止。", turns: turn - 1, stopReason: "max_turns" };
    }

    let reply;
    try {
      reply = await chat(messages, { tools: apiTools });
    } catch (e) {
      return { answer: `调用失败：${(e as Error).message}`, turns: turn, stopReason: "error" };
    }

    messages.push(reply.message);
    onStep?.({ turn, assistant: reply.message });

    // 退出条件一：模型没有再要工具 → 它认为任务完成了
    if (!reply.message.tool_calls?.length) {
      return { answer: reply.message.content ?? "", turns: turn, stopReason: "completed" };
    }

    // 执行模型点名的每个工具
    const results: StepInfo["toolResults"] = [];
    for (const call of reply.message.tool_calls) {
      const result = await runTool(call, tools);
      results.push({ name: call.function.name, result });
      messages.push({ role: "tool", tool_call_id: call.id, content: result });
    }
    onStep?.({ turn, assistant: reply.message, toolResults: results });
  }
}

/** 执行单个工具调用：查表 → 解析参数 → 执行；任何失败都变成回给模型的文本 */
async function runTool(call: ToolCall, tools: Tool[]): Promise<string> {
  const tool = tools.find((t) => t.name === call.function.name);
  if (!tool) {
    return `ERROR: 未知工具 "${call.function.name}"。可用工具：${tools.map((t) => t.name).join(", ")}`;
  }
  try {
    const args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
    return await tool.execute(args);
  } catch (e) {
    return `ERROR: 工具 ${call.function.name} 执行失败：${(e as Error).message}`;
  }
}
```

注意几个设计决定，每个都是踩过坑换来的：

1. **`maxTurns` 是必设的保险丝**。模型可能陷入死循环（反复调同一个工具、读同一个文件）。没有上限的 Agent 循环 = 一张会烧钱的无底洞。25 步是个常见起点，复杂任务可以放宽。
2. **未知工具名不抛异常**，回一句"可用工具有哪些"。模型点错名是常态，给出正确选项它就能自我纠正。
3. **工具结果统一转字符串**回填（协议要求 content 是文本）。对象要 `JSON.stringify`，长文本要截断（第 4 章做）。
4. **`onStep` 回调**让调用方能看到每一步发生了什么——调试 Agent 的第一工具。第 9 章的终端渲染、第 10 章的日志都从这一个钩子长出来。

## 3.3 循环的三种死法

`stopReason` 枚举了 Agent 的三种结局，每种都要认真对待：

| 结局 | 含义 | 应对 |
|------|------|------|
| `completed` | 模型不再要求工具，给出最终答案 | 正常路径 |
| `max_turns` | 步数保险丝烧断 | 通常是任务拆太粗、工具太弱或死循环；先看 trace 再调大步数 |
| `error` | API 层失败（网络、限流、余额） | 重试与降级，第 10 章的 eval 框架会统计这类失败 |

还有第四种更隐蔽的"假完成"：模型**没调工具、也没完成任务**，直接说"抱歉我做不到"。`completed` 不代表成功——第 10 章的评测会区分"答了"和"答对了"。

## 3.4 跑一个真实的 Agent

> `src/demos/03-files.ts` —— 给 agent 三个文件工具，让它自主完成统计任务

```ts
import { readdir, readFile, stat } from "node:fs/promises";
import { agentLoop, type Tool } from "../lib/agent";

const ROOT = "./notes"; // 演示目录，先建几个 .md 文件放进去

const listFiles: Tool = {
  name: "list_files",
  description: "列出指定目录下的文件和子目录名（不递归）",
  parameters: {
    type: "object",
    properties: { dir: { type: "string", description: "目录路径，默认当前目录" } },
  },
  execute: async (args) => {
    const { dir = "." } = args as { dir?: string };
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.map((e) => `${e.isDirectory() ? "dir " : "file"} ${e.name}`).join("\n") || "(空目录)";
  },
};

const readFileTool: Tool = {
  name: "read_file",
  description: "读取一个文本文件的完整内容",
  parameters: {
    type: "object",
    properties: { path: { type: "string", description: "文件路径" } },
    required: ["path"],
  },
  execute: async (args) => {
    const { path } = args as { path: string };
    const content = await readFile(path, "utf8");
    return content.length > 8000 ? content.slice(0, 8000) + "\n…(已截断)" : content;
  },
};

const countChars: Tool = {
  name: "count_chars",
  description: "统计一个字符串的字符数（含空白）",
  parameters: {
    type: "object",
    properties: { text: { type: "string", description: "要统计的文本" } },
    required: ["text"],
  },
  execute: async (args) => {
    const { text } = args as { text: string };
    return `${text.length}`;
  },
};

const result = await agentLoop(
  [{ role: "user", content: "统计 ./notes 目录下每个 markdown 文件的字数，并给出总计" }],
  {
    tools: [listFiles, readFileTool, countChars],
    system: "你是一个文件助手。一步步来，先看目录再逐个处理。最终用表格汇报。",
    onStep: ({ turn, toolResults }) => {
      for (const r of toolResults ?? []) {
        console.log(`[turn ${turn}] ${r.name} → ${r.result.slice(0, 60).replace(/\n/g, "⏎")}…`);
      }
    },
  },
);

console.log(`\n=== 完成（${result.turns} 轮，${result.stopReason}）===`);
console.log(result.answer);
```

跑起来，你会看到模型**自己规划**出 `list_files → read_file ×N → count_chars ×N → 汇总` 的路径。没有人告诉它这个顺序——它从工具描述和任务描述里推理出来的。

## 3.5 换个角度看：循环里藏着什么

把 `agentLoop` 和真实框架对照，你会发现全对得上：

| 本教程 | Claude Code / 通用 Agent 术语 |
|--------|------------------------------|
| `messages` 数组 | 会话上下文 / transcript |
| `tools` 清单 | 工具集（通常按权限模式增减） |
| `maxTurns` | 步数/预算限制 |
| `onStep` | 事件流 / streaming UI 的数据源 |
| `runTool` 的错误回填 | 工具错误处理策略 |
| system prompt | Agent 的 operating manual |

后面章节只是替换这张表里的实现：第 4 章重写 `Tool`（Zod + 安全执行），第 5 章在循环里插入压缩，第 8 章在 `runTool` 前插审批，第 9 章把 `onStep` 变成终端渲染。**骨架不再变。**

## 练习

1. 把演示里的 `count_chars` 拿掉，只留文件工具。模型还能完成任务吗？（能——它会自己数字符。这告诉你：**工具不必把"最后一步"也自动化，把可复用、易出错的部分做成工具即可**。）
2. 把 `maxTurns` 设成 2 跑一遍，观察 `max_turns` 结局。再把任务改得超出 2 步能力，体会"步数预算 = 任务复杂度上限"。
3. （为第 4 章埋伏笔）试着给 `read_file` 传一个不存在的路径，观察模型收到 ERROR 后的行为。

## 常见坑

- **不设 `maxTurns` 就上生产**：迟早遇到死循环烧钱。
- **在工具里用 `console.log` 打日志到 stdout**：多轮循环时输出混成一团；统一走 `onStep` 或 stderr。
- **把用户的下一句话也塞进同一个循环**：一个循环干一件事；交互式多轮对话要在循环外再包一层（第 12 章的 mini-agent 会展示这个结构）。
- **误把 `completed` 当成功**：见 3.3 第四种死法。

---

上一章：[第 2 章](02-tool-calling.md) · 下一章：[第 4 章 · 工具系统](04-tool-system.md)
