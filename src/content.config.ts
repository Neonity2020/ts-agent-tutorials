import { defineCollection, z } from "astro:content";
import { glob } from "astro/loaders";
import { readdirSync } from "node:fs";

// 教程正文就在仓库根目录（00-introduction.md … appendix.md），这里直接把根目录
// 当作内容源，不移动任何原始文件——教程仓库本身保持干净。
//
// 为什么不直接写 glob({ pattern: "*.md", base: "." })：
// Astro 内部用的是 tinyglobby，只要 pattern 带通配符就会整棵目录树遍历，
// 而本项目根下挂着两个 node_modules（本仓库 279 个包 + code/ 103 个包），
// 实测会把构建卡住数分钟。所以这里用 readdirSync 做一次**非递归**列举，
// 把具体的文件名（字面量、不含通配符）交给 glob loader 走静态快速路径。
// 新增章节文件会被自动纳入，无需改这里。
//
// 注意：正文没有 frontmatter，标题/章节号/文件清单全部从正文解析
// （见 src/lib/docs.ts 的 parseDoc），因此 schema 只声明可选的覆盖字段。

/** 根目录下的教程正文，排除 README */
const DOC_FILES = readdirSync(process.cwd()).filter(
  (f) => f.endsWith(".md") && f !== "README.md",
);

const docs = defineCollection({
  loader: glob({ pattern: DOC_FILES, base: "." }),
  schema: z.object({
    /** 可选：仅当你想在 frontmatter 里手动覆盖正文解析出的标题时使用 */
    title: z.string().optional(),
    description: z.string().optional(),
  }),
});

export const collections = { docs };