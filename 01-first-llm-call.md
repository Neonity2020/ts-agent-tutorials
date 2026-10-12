# 第 1 章 · 直连 LLM API

> 本章新增文件：`src/lib/llm.ts`、`src/demos/01-hello.ts`、`src/demos/01-stream.ts`

**本章你会学会：**

- Chat Completions API 的请求与响应结构（一切的地基）
- 把 API 封装成类型安全的 `chat()` 函数
- 流式输出（SSE）的原理与解析
- 用 AbortController 实现取消与超时

我们不用任何 SDK，直接 `fetch`。原因：OpenAI 兼容接口是事实标准（GLM、DeepSeek、OpenAI、Moonshot 全兼容），手写一遍 HTTP 层，你对"模型调用到底发生了什么"就再也没有神秘感了。

## 1.1 一次调用长什么样

LLM 对话 API 的本质是一个无状态函数：**给它完整的消息列表，它返回下一条消息**。"多轮对话"是客户端的错觉——每一轮你都要把之前所有历史重新发一遍。

```bash
curl -s "$LLM_BASE_URL/chat/completions" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $LLM_API_KEY" \
  -d '{
    "model": "glm-4-flash",
    "messages": [
      { "role": "system", "content": "你是一个简洁的助手" },
      { "role": "user", "content": "用一句话解释什么是递归" }
    ]
  }'
```

响应的结构（省略无关字段）：

```jsonc
{
  "choices": [
    {
      "message": { "role": "assistant", "content": "递归是函数调用自身的编程技巧。" },
      "finish_reason": "stop"
    }
  ],
  "usage": {
    "prompt_tokens": 27,       // 输入消耗
    "completion_tokens": 14,   // 输出消耗
    "total_tokens": 41         // 输入+输出，计费按这个
  }
}
```

三个必须记住的细节：

1. **`system` 消息是给模型的"岗位说明书"**，权重最高。Agent 的人格、规则、工具使用守则都写在这里（第 5 章展开）。
2. **`finish_reason`**：`stop` 是自然说完；`length` 是被 `max_tokens` 截断；`tool_calls` 是模型想调工具（第 2 章）。
3. **`usage`**：token 是钱也是上下文窗口。从第一章就养成看 usage 的习惯，第 5 章管上下文预算全靠它。

## 1.2 封装 `chat()`

> `src/lib/llm.ts`

```ts
import "dotenv/config";

export const BASE_URL = process.env.LLM_BASE_URL ?? "https://open.bigmodel.cn/api/paas/v4";
export const API_KEY = process.env.LLM_API_KEY ?? "";
export const MODEL = process.env.LLM_MODEL ?? "glm-4-flash";

if (!API_KEY) {
  console.error("缺少 LLM_API_KEY，请在 .env 中配置");
  process.exit(1);
}

/** 一条消息。工具相关的字段（tool_calls / tool_call_id）第 2 章启用 */
export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ChatOptions {
  temperature?: number; // 0=最确定，2=最放飞。Agent 干活建议 0~0.7
  maxTokens?: number;
  signal?: AbortSignal;
}

/** 基础调用：发消息列表，拿回 assistant 消息 */
export async function chat(messages: ChatMessage[], opts: ChatOptions = {}) {
  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${API_KEY}`,
    },
    body: JSON.stringify({
      model: MODEL,
      messages,
      temperature: opts.temperature,
      max_tokens: opts.maxTokens,
    }),
    signal: opts.signal ?? AbortSignal.timeout(120_000), // 默认 2 分钟超时
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`LLM API ${res.status}: ${body}`);
  }

  const data = await res.json();
  return {
    message: data.choices[0].message as ChatMessage & { role: "assistant" },
    finishReason: data.choices[0].finish_reason as string,
    usage: data.usage as { prompt_tokens: number; completion_tokens: number; total_tokens: number },
  };
}
```

> `src/demos/01-hello.ts`

```ts
import { chat } from "../lib/llm";

const { message, usage } = await chat([
  { role: "system", content: "你是一个简洁的助手，回答不超过两句话。" },
  { role: "user", content: "用一句话解释什么是递归" },
]);

console.log(message.content);
console.log(`（消耗 ${usage.total_tokens} tokens）`);
```

```bash
npx tsx src/demos/01-hello.ts
```

注意顶层 `await`：tsx 按 ESM 模块执行，可以直接在文件顶层等待 Promise——写演示脚本非常顺手。

## 1.3 流式输出：SSE 逐块解析

非流式调用要等模型把整段话说完才返回，一个长回答要干等十几秒。流式（`stream: true`）让服务端边生成边推送，首字延迟从十几秒降到一秒内——这是所有 AI 应用的"打字机效果"的来源。

底层协议是 **SSE（Server-Sent Events）**：HTTP 长连接上传输一行行 `data: {...}` 文本，用 `data: [DONE]` 表示结束。

> 追加到 `src/lib/llm.ts`

```ts
/** 流式调用：边生成边通过 onDelta 回调吐出增量文本，返回完整文本 */
export async function chatStream(
  messages: ChatMessage[],
  onDelta: (text: string) => void,
  opts: ChatOptions = {},
): Promise<string> {
  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${API_KEY}`,
    },
    body: JSON.stringify({ model: MODEL, messages, stream: true }),
    signal: opts.signal ?? AbortSignal.timeout(120_000),
  });

  if (!res.ok || !res.body) {
    throw new Error(`LLM API ${res.status}: ${await res.text()}`);
  }

  const reader = res.body.getReader();     // 从字节流逐块读
  const decoder = new TextDecoder();
  let buffer = "";                          // 网络包不一定按行对齐，要攒缓冲
  let full = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";             // 最后一段可能不完整，留到下一轮

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;  // 跳过空行、注释行
      const payload = trimmed.slice(5).trim();
      if (payload === "[DONE]") return full;

      const delta = JSON.parse(payload).choices?.[0]?.delta;
      if (delta?.content) {
        full += delta.content;
        onDelta(delta.content);
      }
    }
  }
  return full;
}
```

> `src/demos/01-stream.ts`

```ts
import { chatStream } from "../lib/llm";

const answer = await chatStream(
  [{ role: "user", content: "用 300 字讲讲什么是上下文窗口" }],
  (delta) => process.stdout.write(delta), // 每收到一小段立刻打印
);
process.stdout.write("\n");
```

解析逻辑里最容易被忽略的是 **buffer**：TCP 包的边界和 SSE 事件边界没有对齐关系，一个包里可能有三条事件、半条事件。所以必须先攒进 `buffer`，按行切分，把最后可能不完整的行留回去。这个模式在处理任何流式协议（包括第 9 章的流式工具调用）时都一样。

> **提示**：部分推理模型（如 GLM 深度思考、DeepSeek-R1）会在 `delta.reasoning_content` 里输出思考过程、在 `delta.content` 里输出正式回答。需要时在解析处照 `content` 的方式多处理一个字段即可。

## 1.4 取消与超时：AbortController

用户按 Ctrl+C、请求卡死、请求不再需要——长时任务必须能被中断。Web 标准的做法是 `AbortSignal`，我们已经在 `chat()` 里接好了 `signal` 参数，现在把它用起来：

```ts
// 超时：AbortSignal.timeout 毫秒后自动 abort（本章已默认接上）
await chat(messages, { signal: AbortSignal.timeout(10_000) });

// 手动取消：把 controller.signal 传进去，需要时调 controller.abort()
const controller = new AbortController();
process.on("SIGINT", () => controller.abort("用户中断"));
await chatStream(messages, print, { signal: controller.signal });
```

`abort` 之后，进行中的 `fetch` 会抛出 `AbortError`。记住这个模式——第 8 章会把同一个 signal 一路传到工具执行层，做到"点一下停止，整条链路立刻停下"。

## 1.5 Token 与计费速览

- **1 token ≈ 0.75 个英文单词 ≈ 0.5~1.5 个汉字**（因分词器而异）。粗算：中文按 1 字 ≈ 1 token，英文按 4 字符 ≈ 1 token，上下文预算时留 20% 余量。
- **输入比输出便宜**（通常 1/4~1/10）。历史消息每轮都要重发，所以长对话的成本随轮数平方级增长——这正是第 5 章要做压缩的原因。
- **上下文窗口 = 能塞进一次请求的最大 token 数**。塞不下直接报错（通常是 400 或 413）。模型窗口大小、价格，以服务商定价页为准。

## 练习

1. 给 `chat()` 增加重试：对 429（限流）和 5xx 状态码，指数退避重试 3 次（等 1s、2s、4s），其他错误直接抛。提示：`res.status` 分支 + 递归调用。第 10 章会用到。
2. 把 01-stream.ts 改成：先打印 `思考中...`，收到第一个字时用回车清掉这行再开始流式打印。（答案在 [第 9 章](09-streaming-ui.md)）
3. 打印一次请求的完整 messages 数组，数一数 system + user 的 tokens（用 usage.prompt_tokens 对照你的估算）。

## 常见坑

- **401**：Key 错了或没加载 `.env`；先 `console.log(BASE_URL, MODEL)` 排查。
- **404**：`BASE_URL` 少了或多了路径段（GLM 是 `/v4`，OpenAI 是 `/v1`，DeepSeek 不带 `/v1` 也能用）。
- **`arguments`/JSON 相关报错看不懂**：你还不需要它们，那是第 2 章的事。
- **流式打印出现乱码**：忘了 `decoder.decode(value, { stream: true })`，多字节汉字被从中间截断。
- **把 `usage.total_tokens` 只当输出 tokens**：它是输入+输出。长对话烧钱主要是输入。

---

上一章：[第 0 章](00-introduction.md) · 下一章：[第 2 章 · 工具调用](02-tool-calling.md)
