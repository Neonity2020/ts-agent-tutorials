# 第 9 章 · 流式解析与终端体验

> 本章修改文件：`src/lib/llm.ts`（支持流式工具调用）
> 本章新增文件：`src/lib/ui.ts`、`src/demos/09-tui.ts`、`src/demos/09-sse-server.ts`

**本章你会学会：**

- 解析**流式工具调用**——工具名和参数是分片到达的
- 把决策轨迹渲染成可扫读的终端输出
- 把 Agent 包成 SSE 服务（为 Web 前端供流）

Agent 默认输出是"哑等十几秒，然后倾倒一大段文本"。本章让它的过程像 Claude Code 那样**实时可见**：正在想什么、调了什么工具、结果是什么。这不是美化——长任务里用户看到过程才敢放手，这是信任问题。

## 9.1 流式工具调用：参数是拼出来的

第 1 章解析过流式文本。工具调用更麻烦：**`tool_calls` 也是流式到达的**——`id`、函数名、参数 JSON 全部打碎成增量片段，按 `index` 分组拼装：

```jsonc
// 第 1 个 chunk： { "index": 0, "id": "call_x", "function": { "name": "read_", "arguments": "{\"pa" } }
// 第 2 个 chunk： { "index": 0, "function": { "name": "file", "arguments": "th\":\"src" } }
// 第 N 个 chunk： { "index": 0, "function": { "arguments": "/a.ts\"}" } }   → 拼出完整调用
```

改写 `chatStream` 为全功能版（同时处理文本与工具调用）：

> 追加到 `src/lib/llm.ts`

```ts
export interface StreamAccumulated {
  content: string;
  toolCalls: ToolCall[];
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

/** 全功能流式调用：文本增量即时回调；工具调用分片拼装后随返回值给出 */
export async function chatStreamFull(
  messages: ChatMessage[],
  handlers: {
    onText?: (delta: string) => void;
    onToolName?: (index: number, name: string) => void; // 一拿到函数名就回调（做"正在调用 X"提示）
  },
  opts: ChatOptions = {},
): Promise<StreamAccumulated> {
  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify({ model: MODEL, messages, stream: true, tools: opts.tools }),
    signal: opts.signal,
  });
  if (!res.ok || !res.body) throw new Error(`LLM API ${res.status}: ${await res.text()}`);

  const acc: StreamAccumulated = { content: "", toolCalls: [] };
  const parts = new Map<number, { id: string; name: string; arguments: string }>();
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith("data:")) continue;
      const payload = t.slice(5).trim();
      if (payload === "[DONE]") break;

      const data = JSON.parse(payload); // 原始 SSE 数据对象：usage 在这层，不在 choices 里
      const chunk = data.choices?.[0] ?? {};
      const delta = chunk.delta ?? {};

      if (delta.content) {
        acc.content += delta.content;
        handlers.onText?.(delta.content);
      }
      for (const tc of delta.tool_calls ?? []) {
        const part = parts.get(tc.index) ?? { id: "", name: "", arguments: "" };
        if (tc.id) part.id = tc.id;
        if (tc.function?.name) {
          part.name += tc.function.name;
          handlers.onToolName?.(tc.index, part.name); // 名字还在增长，回调的是当前快照
        }
        if (tc.function?.arguments) part.arguments += tc.function.arguments;
        parts.set(tc.index, part);
      }
      // usage 在 SSE 数据顶层（OpenAI 规范：最后一个数据块带 usage，此时 choices 是空数组）。
      // 从 chunk.usage 取是高频踩坑点：tokens 统计永远为 0，且不报任何错。
      if (data.usage) acc.usage = data.usage;
      else if (chunk.usage) acc.usage = chunk.usage; // 兼容把 usage 塞进 choices[0] 的服务商
    }
  }

  acc.toolCalls = [...parts.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, p]) => ({ id: p.id, type: "function" as const, function: { name: p.name, arguments: p.arguments } }));
  return acc;
}
```

拼装规则就三条：**按 `index` 分组**（并行多工具时互不串线）、**字段是"追加"不是"覆盖"**（arguments 尤其——它是 JSON 字符串的碎片流，拼完整才能 `JSON.parse`）、**工具名完整后不要等参数拼完就可以开始提示**（参数可能很长，如 write_file 的 content）。

`chatStreamFull` 返回的 `StreamAccumulated` 就是一条合法的 assistant 消息（`content` + `tool_calls`），可以直接 push 进 messages、接回第 3 章的循环——把 `agentLoop` 内部的 `chat` 换成 `chatStreamFull`，Agent 就"活"了。

## 9.2 终端渲染：过程可扫读

设计目标：**用户 3 秒能扫完一轮做了什么**。手段是视觉分层——思考流式淡显、工具调用高亮一行、结果折叠成一行摘要、最终答案正常排版。

> `src/lib/ui.ts`（依赖第 3 章 `agentLoop` 的 `onStep` + 本章的流式回调）

```ts
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;

export class AgentUI {
  private thinking = false;

  /** 流式文本：淡显逐字输出（思考/正文），结束后换行 */
  onText(delta: string) {
    if (!this.thinking) {
      process.stdout.write(dim("· "));
      this.thinking = true;
    }
    process.stdout.write(dim(delta));
  }

  endText() {
    if (this.thinking) { process.stdout.write("\n"); this.thinking = false; }
  }

  /** 工具调用开始：高亮一行 */
  onToolStart(name: string, argsPreview: string) {
    this.endText();
    process.stdout.write(`${cyan("▸")} ${bold(name)} ${dim(argsPreview.slice(0, 80))}\n`);
  }

  /** 工具结果：一行摘要，长结果截断 */
  onToolResult(name: string, result: string) {
    const oneLine = result.replace(/\s+/g, " ").trim();
    const mark = result.startsWith("ERROR") ? "✗" : "✓";
    const color = result.startsWith("ERROR") ? (s: string) => `\x1b[31m${s}\x1b[0m` : green;
    process.stdout.write(`  ${color(`${mark} ${name}`)} ${dim(oneLine.slice(0, 100))}${oneLine.length > 100 ? dim(" …") : ""}\n`);
  }

  /** 压缩提示等系统事件 */
  system(msg: string) {
    this.endText();
    process.stdout.write(`${dim(`── ${msg} ──`)}\n`);
  }
}
```

接回 `agentLoop`（改造点：把循环内的 `chat` 换成 `chatStreamFull`，工具执行前后调 UI）：

```ts
const ui = new AgentUI();
const result = await agentLoop(messages, {
  tools,
  onStep: ({ toolResults }) => {
    for (const r of toolResults ?? []) ui.onToolResult(r.name, r.result);
  },
});
```

加上"旋转指示器"（spinner）：请求进行中在行尾画 `⠋⠙⠹…` 转圈，首字节到达即清除。实现是 `setInterval` + `\r` 回车符清行，20 行以内，留作练习。

> 渲染心法：**默认折叠，异常展开**。工具结果只留一行；出错的（✗）才值得多看两眼。信息密度来自克制。

## 9.3 把 Agent 包成 SSE 服务

终端 UI 的同一套原理可以供 Web 前端使用：把 Agent 的事件流用 HTTP SSE 推给浏览器。Node 原生 http 服务（零框架版）：

> `src/demos/09-sse-server.ts`

```ts
import { createServer } from "node:http";
import { agentLoop } from "../lib/agent";

createServer(async (req, res) => {
  if (req.method !== "POST" || req.url !== "/agent") { res.writeHead(404).end(); return; }

  const { task } = await new Promise<any>((r) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => r(JSON.parse(body)));
  });

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  const send = (event: string, data: unknown) =>
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  try {
    const result = await agentLoop([{ role: "user", content: task }], {
      tools,
      onStep: ({ toolResults }) => {
        for (const r of toolResults ?? []) send("tool_result", { name: r.name, result: r.result.slice(0, 500) });
      },
    });
    send("done", { answer: result.answer, stopReason: result.stopReason });
  } catch (e) {
    send("error", { message: (e as Error).message });
  } finally {
    res.end();
  }
}).listen(8080, () => console.log("SSE agent on http://localhost:8080"));
```

前端 `EventSource` / `fetch` 读流即可逐事件渲染——和 9.2 的终端渲染共享同一套事件语义（`onStep` 就是你的事件协议雏形）。生产化还差：鉴权、并发会话隔离、客户端断开时 abort 服务端循环（`req.on("close", () => controller.abort())`，第 8 章的取消在这里复用）。

## 9.4 事件协议：把 onStep 长成正经接口

本章所有渲染都从 `onStep` 回调长出来。趁热把它规范化——定义一套**事件协议**，UI、日志（第 10 章）、SSE 前端全都消费同一份事件流：

```ts
export type AgentEvent =
  | { type: "turn_start"; turn: number }
  | { type: "text_delta"; delta: string }
  | { type: "tool_call_start"; name: string; argsPreview: string }
  | { type: "tool_result"; name: string; result: string; ok: boolean; durationMs: number }
  | { type: "compact"; before: number; after: number }
  | { type: "turn_end"; turn: number }
  | { type: "final"; answer: string; stopReason: string };

export type AgentEmitter = (event: AgentEvent) => void;
```

`agentLoop` 改为收 `emit: AgentEmitter`（`onStep` 成为它的语法糖）。**Agent 核心不再关心渲染与记录，只负责发事件**——这是把第 3 章骨架推向社会化分工的最后一步，第 12 章的 mini-agent 会直接使用这套协议。

## 练习

1. 实现 spinner：`startSpinner(label)` / `stopSpinner()`，请求发出到首个 delta 之间转圈，注意 spinner 与流式输出不能互相打架（先清行再写）。
2. 给 `onToolResult` 加耗时显示（第 10 章的计时会用到），超过 5s 的工具调用渲染为黄色警示。
3. 把 9.3 的服务跑起来，用 `curl -N -X POST localhost:8080/agent -d '{"task":"…"}'` 观察事件流。（`-N` 禁用缓冲，看不到流先查这个。）
4. 挑战：实现 diff 渲染——`write_file` 的工具调用执行前，把新内容与磁盘旧内容做行级 diff（`diff` 库或手写 LCS），红绿渲染后等 `confirm`。这是 coding agent 审批体验的灵魂。

## 常见坑

- **流式模式拿不到 usage（tokens 统计恒为 0 还不报错）**：两个原因叠加。① 按规范 usage 在 SSE 数据**顶层**，且最后一个 chunk 的 `choices` 是空数组——从 `choices[0].usage` 取永远 `undefined`，静默失败；② 部分服务商还要求显式开启 `stream_options: { include_usage: true }`。先解析顶层再补开关，接好后打印一次 `acc.usage` 确认真的拿到了。
- **直接 `JSON.parse` 流中的 arguments**：碎片拼完之前必然抛异常。等 `[DONE]` 或结束再解析（9.1 的 Map 拼装）。
- **终端输出闪烁**：频繁 `console.log` 整行刷新。用 `\r` 原地更新 spinner、增量 write 字符。
- **SSE 被 nginx/代理缓冲**：加 `X-Accel-Buffering: no` 响应头；本地测试用 `curl -N`。
- **并发会话共享一个 UI 实例**：两个任务的输出交错了。UI 实例随会话走，或直接上事件流 + 各自渲染。

---

上一章：[第 8 章](08-control-flow.md) · 下一章：[第 10 章 · 评测与可观测性](10-eval-and-observability.md)
