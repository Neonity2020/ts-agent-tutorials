// 第 3 章示例：Agent 循环跑真实的文件统计任务
import { readFile, readdir } from "node:fs/promises";
import { z } from "zod";
import { agentLoop } from "../lib/agent";
import { defineTool, type AnyTool } from "../lib/tools";
import { ensureNotes } from "./shared";

await ensureNotes(); // 首次运行时创建 notes/ 示例文件

const listFiles: AnyTool = defineTool({
  name: "list_files",
  description: "列出指定目录下的文件和子目录名（不递归）",
  schema: z.object({ dir: z.string().default(".").describe("目录路径") }),
  execute: async ({ dir }) => {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.map((e) => (e.isDirectory() ? "dir " : "file") + " " + e.name).join("\n") || "(空目录)";
  },
});

const readFileTool: AnyTool = defineTool({
  name: "read_file",
  description: "读取一个文本文件的完整内容（超长截断）",
  schema: z.object({ path: z.string().describe("文件路径") }),
  execute: async ({ path }) => {
    const content = await readFile(path, "utf8");
    return content.length > 8000 ? content.slice(0, 8000) + "\n…(已截断)" : content;
  },
});

const countChars: AnyTool = defineTool({
  name: "count_chars",
  description: "统计一个字符串的字符数（含空白）",
  schema: z.object({ text: z.string().describe("要统计的文本") }),
  execute: async ({ text }) => `${text.length}`,
});

let turn = 0;
const result = await agentLoop(
  [{ role: "user", content: "统计 ./notes 目录下每个 markdown 文件的字数，并给出总计" }],
  {
    tools: [listFiles, readFileTool, countChars],
    system: "你是一个文件助手。一步步来，先看目录再逐个处理。最终汇报里必须出现“总计”字样。",
    maxTurns: 15,
    emit: (e) => {
      if (e.type === "turn_start") turn = e.turn;
      if (e.type === "tool_call_start") console.log(`[turn ${turn}] → ${e.name}(${e.argsPreview.slice(0, 60)})`);
    },
  },
);

console.log(`\n=== 完成（${result.turns} 轮，${result.stopReason}）===`);
console.log(result.answer);
