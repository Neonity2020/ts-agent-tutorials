// 第 12 章毕业项目：迷你 Coding Agent
// 运行：npx tsx src/mini-agent.ts [--readonly|--ask|--yolo]
// 输入任务开始，Ctrl+C 中断当前任务（自动保存现场），输入 q 退出
import * as readline from "node:readline/promises";
import { agentLoop } from "./lib/agent";
import { basicTools, ensureNotes } from "./demos/shared";
import { AgentUI } from "./lib/ui";
import { Tracer } from "./lib/trace";
import { saveSession } from "./lib/session";
import type { ToolContext } from "./lib/tools";
import type { PermissionMode } from "./lib/types";

const MODE = ((process.argv.find((a) => a.startsWith("--")) ?? "--ask").slice(2) || "ask") as PermissionMode;

if (!["readonly", "ask", "yolo"].includes(MODE)) {
  console.error("用法：npx tsx src/mini-agent.ts [--readonly|--ask|--yolo]");
  process.exit(1);
}

const ui = new AgentUI();
const controller = new AbortController();
process.on("SIGINT", () => {
  if (controller.signal.aborted) {
    console.error("\n再次中断，强制退出");
    process.exit(130);
  }
  controller.abort(new Error("用户中断"));
  console.error("\n取消中…（再按一次强制退出）");
});

const SYSTEM = `你是本项目的编程助手（mini coding agent）。

# 工作方式
- 动手前先 list_files / read_file 了解现状，禁止凭想象修改未读过的文件
- 修改代码后用 run_command 验证（如 npx tsx <file> 或 npm test）
- 一次任务只解决一个问题，结束时汇报：改动文件、验证结果、遗留风险

# 约束
- 只操作项目目录内的文件；不改测试来让测试通过
- write_file 是整文件覆盖：改动现有文件前必须先 read_file 拿到全文`;

const stdin = readline.createInterface({ input: process.stdin, output: process.stdout });

async function main() {
  await ensureNotes();
  console.log(`mini-agent 就绪 [模式: ${MODE}]。输入任务开始，Ctrl+C 中断当前任务，输入 q 退出。\n`);

  while (true) {
    const task = (await stdin.question("> ")).trim();
    if (!task) continue;
    if (["q", "quit", "exit"].includes(task.toLowerCase())) break;

    const tracer = await Tracer.start({ mode: MODE, task });
    const ctx: ToolContext = {
      signal: controller.signal,
      confirm: async ({ action, detail }) => {
        if (MODE === "yolo") return true;
        if (MODE === "readonly") return false;
        const ans = (await stdin.question(`  ⚠ ${action}: ${detail} [y/N] `)).trim().toLowerCase();
        return ans === "y";
      },
    };

    try {
      const result = await agentLoop(
        [{ role: "system", content: SYSTEM }, { role: "user", content: task }],
        {
          tools: basicTools(),
          maxTurns: 30,
          budgetTokens: 24_000, // 长任务自动压缩（第 5 章）
          signal: controller.signal, // Ctrl+C 一贯到底（第 1/8 章）
          ctx,
          emit: (e) => {
            tracer.write(e).catch(() => {}); // trace 落盘（第 10 章）
            ui.handle(e); // 终端渲染（第 9 章）
          },
        },
      );
      ui.stopSpinner();
      ui.endText();
      const mark = result.stopReason === "completed" ? "✅" : "⚠️";
      console.log(`\n${mark} ${result.answer}（${result.turns} 轮，累计 ${tracer.tokens} tokens）\n`);
      if (result.stopReason === "aborted") {
        const id = await saveSession(result.messages, { task, mode: MODE });
        console.log(`会话现场已保存：${id}\n`);
      }
    } catch (e) {
      ui.stopSpinner();
      ui.endText();
      console.error(`出错：${(e as Error).message}\n`);
    }
  }
  stdin.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
