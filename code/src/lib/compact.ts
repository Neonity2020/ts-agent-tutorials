// 第 5 章 · 上下文压缩（Agent 的 GC）：估算超预算时，把旧历史压成一条摘要
import { chat, estimateMessagesTokens, type ChatMessage } from "./llm";

const KEEP_RECENT = 8; // 最近 N 条原样保留（当前工作记忆）
const COMPACT_THRESHOLD = 0.8; // 估算 tokens 达到预算 80% 就触发

export interface CompactResult {
  messages: ChatMessage[];
  compacted: boolean;
  before: number;
  after: number;
}

export async function maybeCompact(messages: ChatMessage[], budgetTokens: number): Promise<CompactResult> {
  const before = estimateMessagesTokens(messages);
  if (before < budgetTokens * COMPACT_THRESHOLD) {
    return { messages, compacted: false, before, after: before };
  }

  const system = messages.filter((m) => m.role === "system");
  const rest = messages.filter((m) => m.role !== "system");
  const oldPart = rest.slice(0, rest.length - KEEP_RECENT);
  const recent = rest.slice(-KEEP_RECENT);

  // 配对完整性：recent 首条若是孤立的 tool 消息，把它依赖的 assistant 一并划入 recent
  while (recent.length && recent[0].role === "tool" && oldPart.length) {
    recent.unshift(oldPart.pop()!);
  }

  if (oldPart.length === 0) {
    return { messages, compacted: false, before, after: before }; // 历史本身太短，压无可压
  }

  const summary = await chat(
    [
      {
        role: "system",
        content:
          "你负责压缩一段 AI Agent 的工作记录。输出一段紧凑的摘要（尽量短），必须保留：" +
          "1) 原始任务目标 2) 已完成的步骤和关键结果（含文件路径、数字等具体事实）" +
          "3) 当前的中间状态 4) 尚未完成的事项 5) 重要的用户偏好与约束。不要小说化，不要评论。",
      },
      { role: "user", content: renderForSummary(oldPart) },
    ],
    { temperature: 0 },
  );

  const compacted: ChatMessage[] = [
    ...system,
    {
      role: "user",
      content:
        `<context_summary>\n以下是本次任务早前工作的摘要（原始历史已压缩）：\n\n` +
        `${summary.message.content ?? ""}\n</context_summary>\n\n请基于以上摘要继续完成当前任务。`,
    },
    ...recent,
  ];
  return { messages: compacted, compacted: true, before, after: estimateMessagesTokens(compacted) };
}

/** 把消息数组（含工具调用）渲染成纯文本给摘要模型看 */
function renderForSummary(messages: ChatMessage[]): string {
  return messages
    .map((m) => {
      if (m.role === "assistant" && m.tool_calls?.length) {
        const calls = m.tool_calls.map((c) => `${c.function.name}(${c.function.arguments})`).join("; ");
        return `[assistant 调用工具] ${calls}\n[assistant 说] ${m.content ?? ""}`;
      }
      if (m.role === "tool") return `[工具结果] ${m.content}`;
      return `[${m.role}] ${m.content ?? ""}`;
    })
    .join("\n");
}
