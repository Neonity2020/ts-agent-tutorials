# 第 7 章 · 多 Agent 协作

> 本章新增文件：`src/lib/subagent.ts`、`src/demos/07-research-team.ts`

**本章你会学会：**

- 判断什么时候真的需要多个 Agent
- 实现"主从模式"：主 Agent 派生带独立上下文的子 Agent
- 流水线与并行 fan-out 两种编排
- 多 Agent 的最大陷阱：上下文边界模糊

## 7.1 为什么要多个 Agent：一切为了上下文

先泼冷水：**加 Agent 数量不等于加智能**。多个 Agent 的正当理由只有一个——**上下文隔离**：

1. **保护主上下文**：让子 Agent 去读 20 个文件、翻 50 条搜索结果，主 Agent 只拿到最终结论。探索类任务（"调研一下这个库怎么用"）的主上下文会被中间过程撑爆，这是单 Agent 最大的痛点。
2. **并行提速**：三个互不依赖的子任务，`Promise.all` 同时跑。
3. **职责纯净**：子 Agent 的 system prompt 只写一件事，工具集只留相关的，比一个全能 Agent 的决策质量更高。

反过来说，如果任务上下文本来就不大、步骤天然串行，单 Agent + 好工具就是最优解。**多 Agent 是上下文管理技术（第 5 章）的延伸，不是架构装饰。**

## 7.2 主从模式（Spawn / Subagent）

核心结构：主 Agent 拥有一个 `spawn_agent` 工具；调用它 = 启动一个全新的 `agentLoop`，带独立的 messages、独立（更小）的工具集，跑完只把**最终报告字符串**还给主 Agent。

> `src/lib/subagent.ts`

```ts
import { agentLoop, type AgentOptions } from "./agent";
import { defineTool, type DefinedTool } from "./tools";
import { z } from "zod";

export interface SubagentSpec {
  name: string;           // 给人看的角色名，如 "code-explorer"
  description: string;    // 什么时候派它，主 Agent 靠这个选人
  system: string;         // 子 Agent 的岗位说明书（只写这一件事）
  tools: DefinedTool<z.ZodType>[];
  maxTurns?: number;
}

export function makeSpawnTool(specs: SubagentSpec[]): DefinedTool<z.ZodType> {
  const spawn = async ({ agent, task }: { agent: string; task: string }) => {
    const spec = specs.find((s) => s.name === agent);
    if (!spec) {
      return `ERROR: 未知子 Agent "${agent}"。可用：${specs.map((s) => s.name).join(", ")}`;
    }
    const result = await agentLoop([{ role: "user", content: task }], {
      tools: spec.tools,
      system: spec.system + "\n\n完成后输出一份简洁的最终报告（直接给结论与关键事实，不要罗列过程）。",
      maxTurns: spec.maxTurns ?? 20,
    });
    if (result.stopReason !== "completed") {
      return `子 Agent ${spec.name} 未正常完成（${result.stopReason}，${result.turns} 轮）。部分结果：${result.answer}`;
    }
    return result.answer;
  };

  return defineTool({
    name: "spawn_agent",
    description:
      "派一个子 Agent 独立完成自包含的子任务，等它完成后拿回最终报告。" +
      "task 必须自包含：子 Agent 看不到我们的对话历史，一切它需要的信息都要写进 task。",
    schema: z.object({
      agent: z.string().describe(`选择子 Agent：${specs.map((s) => `${s.name}（${s.description}）`).join("；")}`),
      task: z.string().describe("自包含的任务描述"),
    }),
    execute: spawn,
  });
}
```

设计要点：

- **"task 必须自包含"写进了工具描述**。这是多 Agent 第一大坑：主 Agent 写出"继续刚才那个"这种 task，而子 Agent 根本没有"刚才"。通信即上下文——`task` 就是子 Agent 的全部世界。
- **子 Agent 的报告同样吃主 Agent 的上下文预算**，所以让子 Agent "直接给结论"。如果报告还嫌大，可以在 spawn 包装层再做一次截断或摘要。
- **失败也要返回信息**（`stopReason`），主 Agent 能据此决定重派或自己接手。

主 Agent 侧用法：

```ts
const result = await agentLoop(
  [{ role: "user", content: "调研 src/ 下三个模块各自的职责和依赖关系，输出一份架构摘要" }],
  {
    tools: [makeSpawnTool([explorerSpec, searcherSpec])],
    system: "你是任务协调者。把探索性工作分派给子 Agent，自己只做汇总与判断。",
  },
);
```

注意主 Agent 自己**没有** `read_file`——它只能靠子 Agent 看代码。工具集隔离是刻意的：拿走"自己动手"的选项，强制它委派，主上下文才能保持干净。（要不要保留少数主 Agent 专属工具，取决于任务， Experiment。）

## 7.3 并行 fan-out：Promise.all 的主场

主从模式默认串行（模型一次 spawn 一个）。真正的并行要靠**编排代码**而不是模型自觉。两种做法：

**做法 A：单工具支持多任务批量派发**（推荐，模型一次调用即并行）：

```ts
export function makeSpawnManyTool(specs: SubagentSpec[], concurrency = 4) {
  return defineTool({
    name: "spawn_agents_parallel",
    description: "并行派出多个子 Agent。仅当子任务彼此不依赖时使用。",
    schema: z.object({
      jobs: z.array(z.object({
        agent: z.string(),
        task: z.string(),
      })).min(1).max(6).describe("要并行执行的任务列表"),
    }),
    execute: async ({ jobs }) => {
      const results = await mapWithConcurrency(jobs, concurrency, (j) => spawnOne(j));
      return results
        .map((r, i) => `=== ${jobs[i].agent} / 任务${i + 1} ===\n${r}`)
        .join("\n\n");
    },
  });
}

// 简单并发池：最多 concurrency 个同时跑
async function mapWithConcurrency<T, R>(items: T[], n: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return results;
}
```

关键细节：**并发上限**。无上限 fan-out 会瞬间打出几十个并发 LLM 请求，触发限流（429）甚至烧钱事故。并发池 + 第 1 章练习的重试逻辑是标配。

**做法 B：代码里固定编排**（不经过模型）。如果任务结构你已经知道——"3 个文件并行分析，然后汇总"——直接在 TS 里 `Promise.all` 三个 `agentLoop`，再起一个汇总 `agentLoop`。便宜、确定、可测。**能用代码编排的就别让模型决定编排**，模型编排留给"任务怎么拆要看到中间结果才知道"的场景。

## 7.4 流水线与 handoff

**流水线（pipeline）**：A 的输出是 B 的输入。适合"提取 → 分析 → 写作"这类阶段明确的结构。实现就是串起来的 `agentLoop`，阶段间用**结构化交接**（第 2 章的结构化输出）而不是自由文本：

```ts
const extracted = await agentLoop([{ role: "user", content: raw }], { tools: [extractTool], /* ... */ });
const analyzed = await agentLoop([{ role: "user", content: `基于以下数据回答：${extracted.answer}` }], { tools: [searchTool] });
```

**handoff（控制权移交）**：对话型多 Agent（客服转专员）。一个 Agent 判断"这不归我管"，把**完整对话历史**移交给另一个带不同 system prompt 和工具集的 Agent 继续对话。适合多角色对外服务；内部任务型 Agent 较少用到。实现要点的本质还是那句话：移交的是上下文，不是名字——新 Agent 必须拿到全部历史，否则用户要重述一遍。

## 7.5 成本与复杂度账

多 Agent 不是免费的，上之前算三笔账：

| 成本 | 说明 |
|------|------|
| token 放大 | 每个 spawn 都要重新注入 system + 工具 schema；子任务内部还有多轮。总消耗轻松 ×2~×5 |
| 延迟 | 串行 spawn 是接力等待；只有并行才省时间 |
| 调试面 | 失败点从一个循环变成 N 个循环 + 交接边界。没有第 10 章的 trace，多 Agent 排障是噩梦 |

经验法则：**从单 Agent 开始，出现明确的上下文压力（探索类任务撑爆窗口 / 明显可并行的独立子任务）时，先压缩、后分派；先串行、后并行。**

## 7.6 实战：迷你研究小组

> `src/demos/07-research-team.ts` —— 主 Agent + 两个子 Agent 的完整配置示例：

```ts
import { agentLoop } from "../lib/agent";
import { makeSpawnTool } from "../lib/subagent";
import { readFilesTools, webSearchTools } from "./shared-tools"; // 第 4/6 章的工具

const specs = [
  {
    name: "code-explorer",
    description: "读代码回答结构问题",
    system: "你是代码考古专家。只读代码，回答职责、依赖、数据流问题。报告控制在 300 字内。",
    tools: readFilesTools,       // list_files / read_file / grep
  },
  {
    name: "web-researcher",
    description: "查外部资料回答生态/版本/方案对比问题",
    system: "你是技术调研员。搜索并交叉验证。报告给出结论、来源链接、置信度。",
    tools: webSearchTools,       // web_search / fetch_url
    maxTurns: 12,
  },
];

const result = await agentLoop(
  [{ role: "user", content: process.argv[2] ?? "评估我们项目里的缓存实现与主流方案的差距" }],
  {
    tools: [makeSpawnTool(specs)],
    system:
      "你是技术负责人。先拆解问题，把代码侧与资料侧分别派给子 Agent，" +
      "汇总时必须标明每个结论来自谁。若子 Agent 报告与你的判断冲突，指出并复核。",
    maxTurns: 15,
  },
);
console.log(result.answer);
```

system prompt 里那句"标明每个结论来自谁"值得记住：**多 Agent 的可追责性靠主 Agent 的引用纪律**，出问题时你能知道是哪个环节的锅。

## 练习

1. 给 7.2 的 `spawn_agent` 加 `reportStyle` 参数（`bullet | table | prose`），观察不同报告格式对主 Agent 汇总质量的影响。
2. 把 07-research-team 跑在一个真实问题上，记录：总轮数、主 Agent 上下文 tokens（05-audit）、spawn 次数、总成本。和"单 Agent 不派子"跑同一问题的三项指标对比。
3. 实现"子 Agent 追问"机制：spawn 返回报告时附一个 `followup` 通道（一个特殊工具 `reply_to_subagent(id, question)`），允许主 Agent 对已完成的子 Agent 追问一次（子 Agent 的会话上下文保留待命）。体会"会话生命周期管理"的复杂度从何而来。
4. 挑战：给 `spawn_agents_parallel` 加超时（单任务 3 分钟），超时的任务返回"部分结果 + 超时标记"而不是整体失败。

## 常见坑

- **子 Agent 任务不自包含**："继续处理那个文件"——哪个？主 Agent 必须在 task 里复制粘贴全部必要上下文。宁可 task 长，不可指代。
- **让子 Agent 之间直接对话**：需要新 Agent 消息总线、会话路由和死锁处理。99% 的场景主 Agent 转发就够了——它是天然的协调者。
- **无限递归 spawn**：子 Agent 的工具集里没有 spawn 工具就不会递归；若要嵌套，必须设深度上限并在 system 里声明"你不可以再委派"。
- **并行任务写同一批文件**：并行只该用于只读任务，或严格按资源分区的写入。写冲突的并行 = 数据损坏。
- **迷信"专家会更强"**：换一个 system prompt 不会让弱模型变强。子 Agent 的增益来自隔离与专注，不是"专家人设"。

---

上一章：[第 6 章](06-memory-and-rag.md) · 下一章：[第 8 章 · 规划、审批与取消](08-control-flow.md)
