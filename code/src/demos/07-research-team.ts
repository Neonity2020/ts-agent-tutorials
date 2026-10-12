// 第 7 章示例：主从多 Agent——主 Agent 派子 Agent 探索，自己只做汇总
// 用法：npx tsx src/demos/07-research-team.ts [任务]
import { z } from "zod";
import { agentLoop } from "../lib/agent";
import { defineTool, type AnyTool } from "../lib/tools";
import { makeSpawnTool, type SubagentSpec } from "../lib/subagent";
import { readOnlyTools, ensureNotes } from "./shared";

await ensureNotes();

// 演示用 MOCK 搜索工具：真实项目请接搜索 API
const webSearch: AnyTool = defineTool({
  name: "web_search",
  description: "联网搜索技术资料，返回结果摘要与链接（本 demo 为固定 MOCK 数据）",
  schema: z.object({ query: z.string().describe("搜索词") }),
  execute: async ({ query }) =>
    `MOCK 搜索结果：「${query}」\n` +
    `1. 《缓存设计漫谈》—— 常见策略为旁路缓存与穿透缓存，命中率与失效策略是关键。(example.com/a)\n` +
    `2. 《主流缓存方案对比》—— Redis 与本地缓存各有取舍，分布式场景建议集中式。(example.com/b)\n`,
});

const specs: SubagentSpec[] = [
  {
    name: "code-explorer",
    description: "读本地代码/文件回答结构问题",
    system: "你是代码考古专家。只读文件，回答职责、依赖、数据流问题。报告控制在 300 字内。",
    tools: readOnlyTools(),
    maxTurns: 10,
  },
  {
    name: "web-researcher",
    description: "查外部资料回答生态/方案对比问题",
    system: "你是技术调研员。搜索并交叉验证。报告给出结论、来源、置信度。",
    tools: [webSearch],
    maxTurns: 8,
  },
];

const result = await agentLoop(
  [{ role: "user", content: process.argv[2] ?? "评估 notes 目录描述的模块设计有什么不足，并给出业界常见改进方案" }],
  {
    tools: [makeSpawnTool(specs)],
    system:
      "你是技术负责人。把探索性工作分派给子 Agent，自己只做汇总与判断。" +
      "汇总时必须标明每个结论来自哪个子 Agent。若子 Agent 报告与你的判断冲突，指出并复核。",
    maxTurns: 12,
    emit: (e) => {
      if (e.type === "tool_call_start") console.log(`▸ 主 Agent 调用 ${e.name}`);
      if (e.type === "tool_result") console.log(`  ↳ ${e.name} 返回 ${e.result.length} 字符`);
    },
  },
);

console.log(`\n${result.answer}`);
