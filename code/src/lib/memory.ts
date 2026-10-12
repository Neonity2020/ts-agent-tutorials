// 第 6 章 · 文件型长期记忆：markdown 文件 + Agent 自己维护（remember / update_memory 工具）
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { z } from "zod";
import { defineTool, type AnyTool } from "./tools";

const MEMORY_DIR = "memory";
const MEMORY_PATH = `${MEMORY_DIR}/MEMORY.md`;

/** 启动时注入长期记忆（拼接到 system prompt 末尾） */
export async function loadMemory(path = MEMORY_PATH): Promise<string> {
  try {
    const text = await readFile(path, "utf8");
    return `\n# 已知的项目记忆（此前会话沉淀，可能过时，重要处需核实）\n${text}\n`;
  } catch {
    return ""; // 第一次运行还没有记忆
  }
}

export const rememberTool: AnyTool = defineTool({
  name: "remember",
  description: "把一条值得跨会话记住的事实（用户偏好、项目约定、踩过的坑、关键路径）追加到长期记忆",
  schema: z.object({
    fact: z.string().describe("一句话事实，自包含（不要写“上面提到的”这类指代）"),
    category: z
      .enum(["preference", "convention", "lesson", "fact"])
      .describe("preference=用户偏好, convention=项目约定, lesson=踩坑教训, fact=关键事实"),
  }),
  execute: async ({ fact, category }) => {
    await mkdir(MEMORY_DIR, { recursive: true });
    const date = new Date().toISOString().slice(0, 10);
    await appendFile(MEMORY_PATH, `- [${date}][${category}] ${fact}\n`, "utf8");
    return `已记住：${fact}`;
  },
});

export const updateMemoryTool: AnyTool = defineTool({
  name: "update_memory",
  description: "查看当前全部长期记忆；可删除其中某条（用其完整行内容匹配）",
  schema: z.object({
    deleteLine: z.string().optional().describe("要删除的完整行内容；不传则只查看"),
  }),
  execute: async ({ deleteLine }) => {
    await mkdir(MEMORY_DIR, { recursive: true });
    const text = await readFile(MEMORY_PATH, "utf8").catch(() => "(空)");
    if (!deleteLine) return text;
    const next =
      text
        .split("\n")
        .filter((l) => l.trim() && !l.includes(deleteLine))
        .join("\n") + "\n";
    await writeFile(MEMORY_PATH, next, "utf8");
    return `已删除。当前记忆：\n${next}`;
  },
});
