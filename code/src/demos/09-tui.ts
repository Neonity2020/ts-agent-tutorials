// 第 9 章示例：流式工具调用 + 终端渲染（spinner / 工具行 / 结果摘要）
// 用法：npx tsx src/demos/09-tui.ts [任务] [--yolo 跳过确认]
import { agentLoop } from "../lib/agent";
import { basicTools, ensureNotes } from "./shared";
import { AgentUI } from "../lib/ui";
import { makeConfirm } from "../lib/approval";

await ensureNotes();

const ui = new AgentUI();
const result = await agentLoop(
  [
    {
      role: "user",
      content:
        process.argv[2] ??
        "看看 notes 里有什么，然后写一个 notes/summary.md 总结它们（写入需要你确认）",
    },
  ],
  {
    tools: basicTools(),
    maxTurns: 15,
    ctx: { confirm: makeConfirm(process.argv.includes("--yolo") ? "yolo" : "ask") },
    emit: (e) => ui.handle(e), // 事件流 → 终端渲染
  },
);

ui.stopSpinner();
ui.endText();
console.log(`\n${result.stopReason === "completed" ? "✅" : "⚠️"} ${result.answer}`);
