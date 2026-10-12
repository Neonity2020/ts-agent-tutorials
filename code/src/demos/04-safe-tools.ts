// 第 4 章示例：工具系统——defineTool + 安全执行 + 人工确认
// 用法：npx tsx src/demos/04-safe-tools.ts [任务描述] [--yolo]
import { agentLoop } from "../lib/agent";
import { basicTools } from "./shared";
import { makeConfirm } from "../lib/approval";

const task = process.argv[2] ?? "看看项目里有哪些 markdown 文件，统计每个文件的行数并汇报";
const mode = process.argv.includes("--yolo") ? "yolo" : "ask";

const result = await agentLoop([{ role: "user", content: task }], {
  tools: basicTools(),
  system:
    "你是项目助手。先看目录，再决定下一步；所有写操作与命令执行都会先请求用户确认。结束时给出清晰汇报。",
  maxTurns: 15,
  ctx: { confirm: makeConfirm(mode) },
  emit: (e) => {
    if (e.type === "tool_call_start") console.log(`▸ ${e.name} ${e.argsPreview.slice(0, 80)}`);
    if (e.type === "tool_result") console.log(`  ${e.ok ? "✓" : "✗"} ${e.name}（${e.durationMs}ms）`);
  },
});

console.log(`\n${result.answer}`);
