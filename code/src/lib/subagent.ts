// 第 7 章 · 主从多 Agent：spawn 工具工厂 + 并发池
import { agentLoop } from "./agent";
import { defineTool, type AnyTool } from "./tools";
import { z } from "zod";

export interface SubagentSpec {
  name: string; // 角色名，如 "code-explorer"
  description: string; // 什么时候派它，主 Agent 靠这个选人
  system: string; // 子 Agent 的岗位说明书（只写这一件事）
  tools: AnyTool[];
  maxTurns?: number;
}

async function spawnOne(agent: string, task: string, specs: SubagentSpec[]): Promise<string> {
  const spec = specs.find((s) => s.name === agent);
  if (!spec) {
    return `ERROR: 未知子 Agent "${agent}"。可用：${specs.map((s) => s.name).join(", ")}`;
  }
  const result = await agentLoop([{ role: "user", content: task }], {
    tools: spec.tools,
    system:
      spec.system + "\n\n完成后输出一份简洁的最终报告（直接给结论与关键事实，不要罗列过程）。",
    maxTurns: spec.maxTurns ?? 20,
  });
  if (result.stopReason !== "completed") {
    return `子 Agent ${spec.name} 未正常完成（${result.stopReason}，${result.turns} 轮）。部分结果：${result.answer}`;
  }
  return result.answer;
}

export function makeSpawnTool(specs: SubagentSpec[]): AnyTool {
  return defineTool({
    name: "spawn_agent",
    description:
      "派一个子 Agent 独立完成自包含的子任务，等它完成后拿回最终报告。" +
      "task 必须自包含：子 Agent 看不到我们的对话历史，一切它需要的信息都要写进 task。",
    schema: z.object({
      agent: z
        .string()
        .describe(`选择子 Agent：${specs.map((s) => `${s.name}（${s.description}）`).join("；")}`),
      task: z.string().describe("自包含的任务描述"),
    }),
    execute: ({ agent, task }) => spawnOne(agent, task, specs),
  });
}

export function makeSpawnManyTool(specs: SubagentSpec[], concurrency = 4): AnyTool {
  return defineTool({
    name: "spawn_agents_parallel",
    description: "并行派出多个子 Agent（受并发上限保护）。仅当子任务彼此不依赖时使用。",
    schema: z.object({
      jobs: z
        .array(z.object({ agent: z.string(), task: z.string() }))
        .min(1)
        .max(6)
        .describe("要并行执行的任务列表"),
    }),
    execute: async ({ jobs }) => {
      const results = await mapWithConcurrency(jobs, concurrency, (j) => spawnOne(j.agent, j.task, specs));
      return results.map((r, i) => `=== ${jobs[i].agent} / 任务${i + 1} ===\n${r}`).join("\n\n");
    },
  });
}

/** 简单并发池：最多 n 个同时跑，防限流（429） */
export async function mapWithConcurrency<T, R>(
  items: T[],
  n: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, () => worker()));
  return results;
}
