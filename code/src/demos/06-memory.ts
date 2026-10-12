// 第 6 章示例：文件型长期记忆——启动注入 + Agent 自己维护
// 用法：npx tsx src/demos/06-memory.ts [任务]
import { readFile } from "node:fs/promises";
import { agentLoop } from "../lib/agent";
import { readOnlyTools, ensureNotes } from "./shared";
import { loadMemory, rememberTool, updateMemoryTool } from "../lib/memory";

await ensureNotes();
const memory = await loadMemory();

const task = process.argv[2] ?? "记住：本教程示例项目统一用 pnpm 管理依赖。然后看看 notes 目录里有什么。";

const result = await agentLoop([{ role: "user", content: task }], {
  tools: [rememberTool, updateMemoryTool, ...readOnlyTools()],
  system:
    "你是带长期记忆的助手。遇到值得跨会话记住的事实（用户偏好、项目约定、踩坑教训），调用 remember 工具。" +
    memory, // 启动注入：此前会话沉淀的记忆
  maxTurns: 10,
  emit: (e) => {
    if (e.type === "tool_call_start") console.log(`▸ ${e.name} ${e.argsPreview.slice(0, 80)}`);
  },
});

console.log(`\n${result.answer}`);
console.log("\n===== memory/MEMORY.md 当前内容 =====");
console.log(await readFile("memory/MEMORY.md", "utf8").catch(() => "(还没有记忆文件)"));
