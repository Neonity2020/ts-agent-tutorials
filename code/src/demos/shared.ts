// 多个章节 demo 共用的基础工具集与示例文件（对应第 4 章的工具系统）
import { execFile } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { resolve, sep } from "node:path";
import { z } from "zod";
import { defineTool, type AnyTool } from "../lib/tools";

const run = promisify(execFile);

export const PROJECT_ROOT = resolve(process.cwd());

/** 把模型给的路径锁死在项目目录内，防 ../ 逃逸和绝对路径直读（第 4 章） */
export function resolveProject(userPath: string): string {
  const abs = resolve(PROJECT_ROOT, userPath);
  if (abs !== PROJECT_ROOT && !abs.startsWith(PROJECT_ROOT + sep)) {
    throw new Error(`路径越界：${userPath} 不在项目目录内`);
  }
  return abs;
}

const listFiles = defineTool({
  name: "list_files",
  description: "列出项目内某目录的文件与子目录（不递归）",
  schema: z.object({ dir: z.string().default(".").describe("项目内相对路径") }),
  execute: async ({ dir }) => {
    const entries = await readdir(resolveProject(dir), { withFileTypes: true });
    return entries.map((e) => (e.isDirectory() ? "dir  " : "file ") + e.name).join("\n") || "(空目录)";
  },
});

const readFileTool = defineTool({
  name: "read_file",
  description: "读取项目内文本文件，带行号；大文件用 offset/limit 分页",
  schema: z.object({
    path: z.string().describe("相对路径"),
    offset: z.number().int().min(1).default(1).describe("起始行"),
    limit: z.number().int().min(1).max(500).default(200).describe("最多行数"),
  }),
  execute: async ({ path, offset, limit }) => {
    const lines = (await readFile(resolveProject(path), "utf8")).split("\n");
    const slice = lines.slice(offset - 1, offset - 1 + limit);
    if (!slice.length) return `（文件共 ${lines.length} 行，第 ${offset} 行起无内容）`;
    return (
      slice.map((l, i) => `${String(offset + i).padStart(5)}| ${l}`).join("\n") +
      (offset - 1 + slice.length < lines.length
        ? `\n（未完，共 ${lines.length} 行，用 offset=${offset + limit} 继续读）`
        : "")
    );
  },
});

const writeFileTool = defineTool({
  name: "write_file",
  description: "整文件覆盖式写入（创建或替换）。禁止用于超出任务范围的文件。",
  schema: z.object({ path: z.string(), content: z.string() }),
  execute: async ({ path, content }, ctx) => {
    const abs = resolveProject(path);
    const old = await readFile(abs, "utf8").catch(() => "");
    const ok =
      (await ctx.confirm?.({
        action: "write_file",
        detail: `写入 ${path}（${old ? "修改" : "新建"}，${content.length} 字符）`,
      })) ?? true;
    if (!ok) return "用户拒绝了此次写入，请询问用户或更换方案。";
    await writeFile(abs, content, "utf8");
    return `已写入 ${path}（${content.length} 字符）`;
  },
});

const ALLOWED_COMMANDS = new Set(["ls", "cat", "grep", "wc", "head", "tail", "node", "npx", "git", "npm", "tsc"]);

const runCommandTool = defineTool({
  name: "run_command",
  description: "在项目根目录执行白名单命令（查看、测试、构建类）。只读用途。",
  schema: z.object({
    command: z.string().describe("命令名"),
    args: z.array(z.string()).describe("参数逐项给出，不要拼接"),
  }),
  execute: async ({ command, args }, ctx) => {
    if (!ALLOWED_COMMANDS.has(command)) {
      return `ERROR: "${command}" 不在白名单。可用：${[...ALLOWED_COMMANDS].join(", ")}`;
    }
    const ok = (await ctx.confirm?.({ action: "run_command", detail: `${command} ${args.join(" ")}` })) ?? true;
    if (!ok) return "用户拒绝了此命令。";
    const { stdout, stderr } = await run(command, args, {
      cwd: PROJECT_ROOT,
      timeout: 30_000,
      maxBuffer: 1_000_000,
      signal: ctx.signal,
    });
    return ((stdout + stderr).trim() || "(无输出)").slice(0, 4000);
  },
});

export function readOnlyTools(): AnyTool[] {
  return [listFiles, readFileTool];
}

export function basicTools(): AnyTool[] {
  return [listFiles, readFileTool, writeFileTool, runCommandTool];
}

// ---------- 示例目录（第 3/10 章的练习场） ----------

const SAMPLE_A = `# Alpha 模块

Alpha 负责数据采集，支持批量与增量两种模式。

TODO: 增量模式还没做断点续传。
`;

const SAMPLE_B = `# Beta 模块

Beta 负责数据清洗与落盘，依赖 Alpha 的输出。

清洗规则见 config.md。
`;

export async function ensureNotes(): Promise<void> {
  await mkdir("notes", { recursive: true });
  for (const [name, content] of [
    ["alpha.md", SAMPLE_A],
    ["beta.md", SAMPLE_B],
  ] as const) {
    const path = `notes/${name}`;
    try {
      await readFile(path, "utf8");
    } catch {
      await writeFile(path, content, "utf8");
    }
  }
}
