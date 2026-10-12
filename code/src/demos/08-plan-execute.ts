// 第 8 章示例：plan-then-execute + 人工审批 + Ctrl+C 保存会话
// 用法：npx tsx src/demos/08-plan-execute.ts [任务]（交互式，可随时 Ctrl+C）
import { z } from "zod";
import * as readline from "node:readline/promises";
import { agentLoop } from "../lib/agent";
import { defineTool, type AnyTool } from "../lib/tools";
import { basicTools, readOnlyTools, ensureNotes } from "./shared";
import { makeConfirm } from "../lib/approval";
import { saveSession } from "../lib/session";

await ensureNotes();

const task = process.argv[2] ?? "在 notes/ 目录创建 todo.md，为本教程列出三个待补主题，并用 ls 验证文件存在";

const controller = new AbortController();
process.on("SIGINT", () => {
  if (controller.signal.aborted) {
    console.error("\n再次中断，强制退出");
    process.exit(130);
  }
  controller.abort(new Error("用户中断"));
  console.error("\n正在取消…（再按一次强制退出）");
});

const stdin = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = async (q: string) => (await stdin.question(q)).trim().toLowerCase();

// 计划收集器
let submittedPlan = "";
const submitPlan: AnyTool = defineTool({
  name: "submit_plan",
  description: "提交执行计划，等待用户批准。计划需包含：目标、步骤（涉及文件/命令）、风险、验证方式。",
  schema: z.object({ plan: z.string().describe("完整计划文本（markdown）") }),
  execute: async ({ plan }) => {
    submittedPlan = plan;
    return "计划已收到，等待用户审批。在批准前不要执行任何写操作。";
  },
});

// ---------- 阶段一：规划（只给只读工具 + submit_plan，想动手也动不了） ----------
console.log("────── 阶段一：规划（只读工具）──────");
const planResult = await agentLoop([{ role: "user", content: task }], {
  tools: [...readOnlyTools(), submitPlan],
  system: "你是规划者。调研现状后，务必用 submit_plan 工具提交计划。不要执行任何修改。",
  maxTurns: 10,
  signal: controller.signal,
  emit: (e) => {
    if (e.type === "tool_call_start") console.log(`▸ ${e.name}`);
  },
});

if (planResult.stopReason === "aborted") {
  console.log("\n已取消。");
  process.exit(130);
}
const plan = submittedPlan || planResult.answer;

// ---------- 人工卡点 ----------
console.log(`\n════════ 计划 ════════\n${plan}\n`);
const answer = await ask("════════ 按此执行？[y/N] ════════ ");
if (answer !== "y") {
  console.log("已取消，未执行任何修改。");
  process.exit(0);
}

// ---------- 阶段二：执行（完整工具集 + 逐次确认 + 压缩） ----------
console.log("\n────── 阶段二：执行（写操作仍需逐个确认）──────");
const execResult = await agentLoop(
  [
    ...planResult.messages.filter((m) => m.role !== "system"), // 带上规划阶段的调研过程
    {
      role: "user",
      content: `以上是规划阶段的调研过程。请严格按以下已批准的计划执行：\n${plan}\n\n执行中若发现计划不可行，停下来说明，不要自行改目标。`,
    },
  ],
  {
    tools: basicTools(),
    system:
      "你是执行者。按计划干活，每次写操作与命令执行都会请求用户确认。完成后汇报：改动文件、验证结果、遗留风险。",
    maxTurns: 30,
    budgetTokens: 24_000,
    signal: controller.signal,
    ctx: { confirm: makeConfirm("ask") },
    emit: (e) => {
      if (e.type === "tool_call_start") console.log(`▸ ${e.name} ${e.argsPreview.slice(0, 60)}`);
      if (e.type === "tool_result") console.log(`  ${e.ok ? "✓" : "✗"} ${e.name}`);
      if (e.type === "compact") console.log(`  …上下文已压缩 ${e.before} → ${e.after} tokens`);
    },
  },
);

if (execResult.stopReason === "aborted") {
  const id = await saveSession(execResult.messages, { task, phase: "execute" });
  console.log(`\n已中断，会话现场已保存：${id}（可用 loadSession 恢复续跑）`);
  process.exit(130);
}

console.log(`\n${execResult.answer}`);
stdin.close();
