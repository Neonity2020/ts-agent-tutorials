// 第 3 章（第 12 章定稿） · Agent 循环：LLM + 工具 + while
// 整合了：流式调用（第 9 章）、安全工具执行（第 4 章）、上下文压缩（第 5 章）、统一事件流（第 9/10 章）
import { chatStreamFull, type ChatMessage } from "./llm";
import { runToolCall, type AnyTool, type ToolContext } from "./tools";
import { maybeCompact } from "./compact";
import type { AgentEvent } from "./events";

export interface AgentOptions {
  tools?: AnyTool[];
  system?: string;
  maxTurns?: number; // 防失控保险丝
  budgetTokens?: number; // 触发压缩的上下文预算（第 5 章）
  signal?: AbortSignal; // 一贯到底的取消（第 1/8 章）
  ctx?: ToolContext; // confirm / signal（第 4/8 章）
  emit?: (e: AgentEvent) => void; // 统一事件流（第 9/10 章）
}

export type StopReason = "completed" | "max_turns" | "aborted";

export interface AgentResult {
  answer: string;
  turns: number;
  stopReason: StopReason;
  /** 全程消息（含 system），可用于审计与断点保存 */
  messages: ChatMessage[];
}

export async function agentLoop(input: ChatMessage[], opts: AgentOptions = {}): Promise<AgentResult> {
  const emit = opts.emit ?? (() => {});
  const messages: ChatMessage[] =
    opts.system && !input.some((m) => m.role === "system")
      ? [{ role: "system", content: opts.system }, ...input]
      : [...input];

  let turn = 0;
  try {
    while (true) {
      turn++;
      if (turn > (opts.maxTurns ?? 25)) {
        return { answer: "达到最大步数限制，任务中止。", turns: turn - 1, stopReason: "max_turns", messages };
      }

      // ① 压缩检查：只压历史，system 永远原样保留（第 5 章）
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
        { tools: opts.tools?.map(toApiTool), signal: opts.signal },
      );
      if (acc.usage) {
        emit({ type: "usage", promptTokens: acc.usage.prompt_tokens, completionTokens: acc.usage.completion_tokens });
      }

      messages.push({
        role: "assistant",
        content: acc.content || null,
        ...(acc.toolCalls.length ? { tool_calls: acc.toolCalls } : {}),
      });
      emit({ type: "turn_end", turn });

      // ③ 退出条件：模型不再要工具 → 任务完成
      if (!acc.toolCalls.length) {
        return { answer: acc.content, turns: turn, stopReason: "completed", messages };
      }

      // ④ 安全执行每个工具（第 4 章：校验/超时/截断/错误自愈/确认）
      const ctx: ToolContext = { ...opts.ctx, signal: opts.ctx?.signal ?? opts.signal };
      for (const call of acc.toolCalls) {
        const t0 = Date.now();
        emit({
          type: "tool_call_start",
          name: call.function.name,
          argsPreview: call.function.arguments.slice(0, 80),
        });
        const result = await runToolCall(call, opts.tools ?? [], ctx);
        emit({
          type: "tool_result",
          name: call.function.name,
          result,
          ok: !result.startsWith("ERROR"),
          durationMs: Date.now() - t0,
        });
        messages.push({ role: "tool", tool_call_id: call.id, content: result });
      }
    }
  } catch (e) {
    // Ctrl+C：返回 aborted 让调用方保存现场，而不是抛穿
    if (opts.signal?.aborted) {
      return { answer: "", turns: turn, stopReason: "aborted", messages };
    }
    throw e;
  }
}

function toApiTool(t: AnyTool) {
  return { type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } };
}
