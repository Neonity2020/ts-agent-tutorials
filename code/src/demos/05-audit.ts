// 第 5 章示例：上下文审计——看看模型到底"看到"了什么
import { agentLoop } from "../lib/agent";
import { readOnlyTools, ensureNotes } from "./shared";
import { auditContext } from "../lib/audit";

await ensureNotes();

const result = await agentLoop(
  [{ role: "user", content: process.argv[2] ?? "看看 notes 目录下有什么文件，并总结每个文件的主题" }],
  { tools: readOnlyTools(), maxTurns: 12 },
);

auditContext(result.messages);
console.log(`\n最终回答：\n${result.answer}`);
