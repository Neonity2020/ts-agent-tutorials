// 第 5 章 · 上下文审计：Agent 行为诡异时，把模型"看到"的东西打印出来看
import { estimateTokens, type ChatMessage } from "./llm";

export function auditContext(messages: ChatMessage[]): void {
  const sizes = messages.map((m) => estimateTokens(m.content ?? ""));
  const total = sizes.reduce((a, b) => a + b, 0) || 1;
  console.log(`\n===== 上下文审计：${messages.length} 条消息 ≈ ${total} tokens =====`);
  messages.forEach((m, i) => {
    const label = m.tool_calls?.length ? "assistant(tool_calls)" : m.role;
    const preview = (m.content ?? m.tool_calls?.map((c) => c.function.name).join(",") ?? "")
      .slice(0, 64)
      .replace(/\n/g, "⏎");
    const bar = "█".repeat(Math.round((sizes[i] / total) * 40));
    console.log(
      `${String(i).padStart(3)} [${label.padEnd(21)}] ${String(sizes[i]).padStart(6)}t ${bar} ${preview}`,
    );
  });
}
