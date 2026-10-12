// 第 1、9 章 · LLM 调用层：chat / chatStream / chatStreamFull / token 估算
import "dotenv/config";

export const BASE_URL = process.env.LLM_BASE_URL ?? "https://open.bigmodel.cn/api/paas/v4";
export const API_KEY = process.env.LLM_API_KEY ?? "";
export const MODEL = process.env.LLM_MODEL ?? "glm-4-flash";
export const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL ?? "embedding-3";

if (!API_KEY) {
  console.error("缺少 LLM_API_KEY：请复制 .env.example 为 .env 并填入你的 Key");
  process.exit(1);
}

// ---------- 类型 ----------

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface ChatOptions {
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  tools?: unknown[];
}

export interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

function headers(): Record<string, string> {
  return { "Content-Type": "application/json", Authorization: `Bearer ${API_KEY}` };
}

// ---------- 非流式调用 ----------

export async function chat(messages: ChatMessage[], opts: ChatOptions = {}) {
  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      model: MODEL,
      messages,
      temperature: opts.temperature,
      max_tokens: opts.maxTokens,
      tools: opts.tools,
    }),
    signal: opts.signal ?? AbortSignal.timeout(120_000),
  });
  if (!res.ok) throw new Error(`LLM API ${res.status}: ${await res.text()}`);

  const data = await res.json();
  return {
    message: data.choices[0].message as ChatMessage,
    finishReason: data.choices[0].finish_reason as string,
    usage: data.usage as Usage,
  };
}

// ---------- 流式调用（第 1 章教学版：只处理文本增量） ----------

export async function chatStream(
  messages: ChatMessage[],
  onDelta: (text: string) => void,
  opts: ChatOptions = {},
): Promise<string> {
  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ model: MODEL, messages, stream: true }),
    signal: opts.signal ?? AbortSignal.timeout(120_000),
  });
  if (!res.ok || !res.body) throw new Error(`LLM API ${res.status}: ${await res.text()}`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = ""; // 网络包不按 SSE 事件边界对齐，必须攒缓冲
  let full = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? ""; // 最后一段可能不完整，留到下一轮

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
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

// ---------- 流式调用（第 9 章全功能版：文本增量回调 + 工具调用分片拼装） ----------

export interface StreamHandlers {
  onText?: (delta: string) => void;
  /** 函数名拼装完成即可收到回调（此时参数可能还在传输） */
  onToolName?: (index: number, name: string) => void;
}

export interface StreamAccumulated {
  content: string;
  toolCalls: ToolCall[];
  usage?: Usage;
}

export async function chatStreamFull(
  messages: ChatMessage[],
  handlers: StreamHandlers = {},
  opts: ChatOptions = {},
): Promise<StreamAccumulated> {
  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      model: MODEL,
      messages,
      stream: true,
      tools: opts.tools,
      temperature: opts.temperature,
    }),
    signal: opts.signal ?? AbortSignal.timeout(120_000),
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

      const data = JSON.parse(payload);
      const chunk = data.choices?.[0] ?? {};
      const delta = chunk.delta ?? {};

      if (delta.content) {
        acc.content += delta.content;
        handlers.onText?.(delta.content);
      }
      // 工具调用按 index 分组、字段为追加式拼装（并行多工具互不串线）
      for (const tc of delta.tool_calls ?? []) {
        const part = parts.get(tc.index) ?? { id: "", name: "", arguments: "" };
        if (tc.id) part.id = tc.id;
        if (tc.function?.name) {
          part.name += tc.function.name;
          handlers.onToolName?.(tc.index, part.name);
        }
        if (tc.function?.arguments) part.arguments += tc.function.arguments;
        parts.set(tc.index, part);
      }
      // usage 在 SSE 数据顶层（OpenAI 规范：最后一个数据块带 usage，此时 choices 为空数组）
      if (data.usage) acc.usage = data.usage;
      // 兼容把 usage 塞进 choices[0] 的服务商
      else if (chunk.usage) acc.usage = chunk.usage;
    }
  }

  acc.toolCalls = [...parts.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, p]) => ({ id: p.id, type: "function" as const, function: { name: p.name, arguments: p.arguments } }));
  return acc;
}

// ---------- token 估算（第 5 章：粗估用于预算判断，usage.prompt_tokens 是实测） ----------

export function estimateTokens(text: string): number {
  const cjk = (text.match(/[\u4e00-\u9fff]/g) ?? []).length;
  const other = text.length - cjk;
  return Math.ceil(cjk * 1.1 + other / 3.5);
}

export function estimateMessagesTokens(messages: ChatMessage[]): number {
  return messages.reduce((sum, m) => sum + estimateTokens(m.content ?? ""), 0);
}
