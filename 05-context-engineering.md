# 第 5 章 · 上下文工程：Agent 的内存管理

> 本章修改文件：`src/lib/agent.ts`（循环内插入压缩检查）
> 本章新增文件：`src/lib/compact.ts`、`src/demos/05-audit.ts`

**本章你会学会：**

- 把上下文窗口当内存来预算管理
- 实现历史压缩（compaction）
- 写一份 Agent 级的 system prompt
- 用"上下文审计"方法排查 90% 的 Agent 异常行为

> "Context engineering is the No.1 job of the agent engineer." —— 社区共识，大意如此

## 5.1 为什么上下文会坏掉

Agent 循环每转一圈，`messages` 就长胖一圈。三个敌人：

1. **窗口上限**：塞不下直接 400 报错，任务戛然而止。
2. **成本**：历史每轮全量重发，40 轮的长任务输入 tokens 是平方级增长。
3. **质量衰减**（最隐蔽）：上下文塞满陈旧的工具输出、被否定的方案、重复的文件内容后，模型注意力被稀释，开始忘记目标、重复劳动、抓错重点。**没到窗口上限，质量先崩。**

所以上下文管理的目标不是"能塞下"，而是**任何时刻窗口里都是"完成任务所需的最小充分信息"**。

预算怎么分？一个可操作的起点（按 128k 窗口）：

| 区块 | 预算 | 说明 |
|------|------|------|
| system prompt + 工具 schema | ~5% | 固定开销，第 4 章的描述质量直接花在这里 |
| 任务目标 + 长期记忆注入 | ~5% | 第 6 章 |
| 压缩后的工作摘要 | ~10% | 本章 compaction 产物 |
| 近期对话与工具往返 | ~30% | 压缩要保留的部分 |
| 工具结果（近期、未压缩） | ~40% | 最大头，靠截断和分页控制 |
| **余量** | ~10% | 输出 + 安全边际 |

## 5.2 token 计数：够用就好

精确计数需要各家的 tokenizer，没必要。工程上用两级方案：

```ts
// 粗估：中英文混合的经验比值。预算判断够用了。
export function estimateTokens(text: string): number {
  const cjk = (text.match(/[\u4e00-\u9fff]/g) ?? []).length;
  const other = text.length - cjk;
  return Math.ceil(cjk * 1.1 + other / 3.5); // 汉字≈1 token 出头，其他≈4字符/token
}

export function estimateMessagesTokens(messages: ChatMessage[]): number {
  return messages.reduce((sum, m) => sum + estimateTokens(m.content ?? ""), 0);
}
```

误差 ±20% 无所谓——压缩阈值本来就要留余量。**需要精确值的唯一场合**是判断"下一轮会不会爆窗口"，而每次响应的 `usage.prompt_tokens` 就是最准的实测值：把上一轮的 usage 存下来，比任何估算都可靠。两种手段一起用：估算做日常判断，usage 做硬校验。

## 5.3 压缩（Compaction）：Agent 的 GC

四种候选策略，先排除两个：

- **直接截断旧消息**：简单粗暴，但旧任务状态全部丢失，模型会重复已完成的步骤。❌
- **滑动窗口只留最近 N 条**：同上，且半截工具调用/回填会破坏配对，API 直接 400。❌
- **摘要压缩（compaction）**：把旧历史让模型压成一段"工作摘要"，保留目标、关键决定、未完成项。✅
- **外置化**：把大块信息（文件内容、搜索结果）写到磁盘/存储，上下文里只留引用。✅（第 6 章的 memory、第 4 章的文件分页都是它）

> `src/lib/compact.ts`

```ts
import { chat, estimateMessagesTokens, type ChatMessage } from "./llm";

const KEEP_RECENT = 8;      // 压缩时保留最近 N 条消息原样
const COMPACT_THRESHOLD = 0.8; // 估算 tokens 达到预算的 80% 就触发

/** 估算超阈值时，把旧历史压缩成一条摘要消息，返回新数组（不改原数组） */
export async function maybeCompact(
  messages: ChatMessage[],
  budgetTokens: number,
): Promise<{ messages: ChatMessage[]; compacted: boolean; before: number; after: number }> {
  const before = estimateMessagesTokens(messages);
  if (before < budgetTokens * COMPACT_THRESHOLD) {
    return { messages, compacted: false, before, after: before };
  }

  const system = messages.filter((m) => m.role === "system");
  const rest = messages.filter((m) => m.role !== "system");
  const oldPart = rest.slice(0, -KEEP_RECENT);
  const recent = rest.slice(-KEEP_RECENT);

  const summary = await chat(
    [
      {
        role: "system",
        content:
          "你负责压缩一段 AI Agent 的工作记录。输出一段紧凑的摘要（尽量短），必须保留：" +
          "1) 原始任务目标 2) 已完成的步骤和关键结果（含文件路径、数字等具体事实）" +
          "3) 当前的中间状态 4) 尚未完成的事项 5) 重要的用户偏好与约束。不要小说化，不要评论。",
      },
      { role: "user", content: renderForSummary(oldPart) },
    ],
    { temperature: 0 },
  );

  const compacted: ChatMessage[] = [
    ...system,
    {
      role: "user",
      content:
        `<context_summary>\n以下是本次任务早前工作的摘要（原始历史已压缩）：\n\n` +
        `${summary.message.content}\n</context_summary>\n\n请基于以上摘要继续完成当前任务。`,
    },
    ...recent,
  ];
  return { messages: compacted, compacted: true, before, after: estimateMessagesTokens(compacted) };
}

/** 把消息数组（含工具调用）渲染成纯文本给摘要模型看 */
function renderForSummary(messages: ChatMessage[]): string {
  return messages
    .map((m) => {
      if (m.role === "assistant" && m.tool_calls?.length) {
        const calls = m.tool_calls.map((c) => `${c.function.name}(${c.function.arguments})`).join("; ");
        return `[assistant 调用工具] ${calls}\n[assistant 说] ${m.content ?? ""}`;
      }
      if (m.role === "tool") return `[工具结果] ${m.content}`;
      return `[${m.role}] ${m.content ?? ""}`;
    })
    .join("\n");
}
```

插进循环（`agentLoop` 里每次请求模型之前）：

```ts
// while 循环开头处：
const c = await maybeCompact(messages, budgetTokens);
if (c.compacted) {
  messages.splice(0, messages.length, ...c.messages); // 原地替换
  onStep?.({ turn, assistant: { role: "assistant", content: `[上下文已压缩: ${c.before} → ${c.after} tokens]` } });
}
```

实现要点：

- **压缩本身是一次普通的 LLM 调用**，所以它也有成本——阈值设在 80% 而不是 99%，避免"爆窗口前才手忙脚乱压一次"，也让压缩不必太频繁。
- **保留最近 N 条不压**：模型当前的"工作记忆"（刚读的文件、刚做的决定）在最近几条里，压掉它会断片。N=8（约 2~4 轮往返）是常用值。
- **压缩后摘要以 user 消息出现**并明确标注"这是摘要"，让模型知道前面发生了什么、该接着干。
- **消息配对完整性**：`KEEP_RECENT` 的切分要避免把 assistant(tool_calls) 和它对应的 tool 结果切到两边——最稳妥的做法是摘要完成后**校验**：recent 里若存在孤立的 `role:"tool"`，就把它前面的 assistant 也并进 recent。这个校验留给练习。

## 5.4 工具结果：上下文的最大污染源

长任务里占上下文大头的往往不是对话，是工具返回。除了第 4 章的 `MAX_RESULT_CHARS` 截断，还有两招：

**读文件带行号、可分页**（4.1 的 `read_file` 已经做了）：模型读到"第 1-200 行，共 850 行"就知道还有多少、该不该继续读。不带行号的模型引用代码时你都没法定位。

**重复读取去重**：模型经常反复读同一个文件。在工具层做个小缓存：同路径 + 同内容 hash 重复请求时，返回 `(与上次读取相同，共 N 字符)`——一行代码省一半上下文，实现留给练习。

## 5.5 System Prompt：Agent 的岗位说明书

Agent 的 system prompt 不是"你是一个乐于助人的助手"，是一份**操作手册**。一份合格的骨架：

```ts
const systemPrompt = `你是本项目的代码维护助手。

# 职责
在项目目录内完成用户交给你的代码任务。

# 工作方式
- 先用 list_files / read_file 了解现状，再动手；禁止凭想象修改未读过的文件
- 修改后必须用 run_command 验证（如 npm test）
- 单步不确定时，向用户说明你的假设后继续，不要停下来等确认

# 约束
- 只修改项目目录内的文件
- 不修改 tests/ 下的用例来让测试通过
- 每次只做一类修改，便于回滚

# 输出约定
- 结束时汇报：改了哪些文件、验证结果、遗留风险`;
```

四段式：**职责（你是谁）→ 工作方式（怎么干活的流程）→ 约束（红线）→ 输出约定（怎么收尾）**。写它的心法和写工具描述一致：这是给模型读的规则，要具体、可执行、可判定。"要聪明一点"是废话，"修改后必须跑测试"是规则。

注意约束的现实性：模型会服从"禁止改测试"这类明确红线，但服从不了"要有工程品味"这种审美指令——后者要拆成可判定的子规则。

## 5.6 上下文审计：90% 异常的第一诊断法

Agent 行为诡异（忘记指令、重复干活、答非所问）时，别猜，**把发给模型的 messages 全部打印出来看**：

> `src/demos/05-audit.ts`

```ts
import { estimateTokens, type ChatMessage } from "../lib/llm";

export function auditContext(messages: ChatMessage[]) {
  const total = messages.reduce((s, m) => s + estimateTokens(m.content ?? ""), 0);
  console.log(`\n===== 上下文审计：${messages.length} 条消息 ≈ ${total} tokens =====`);
  messages.forEach((m, i) => {
    const label = m.tool_calls ? "assistant(tool_calls)" : m.role;
    const preview = (m.content ?? m.tool_calls?.map((c) => c.function.name).join(",") ?? "")
      .slice(0, 72)
      .replace(/\n/g, "⏎");
    const bar = "█".repeat(Math.round((estimateTokens(m.content ?? "") / total) * 40));
    console.log(`${String(i).padStart(3)} [${label.padEnd(22)}] ${String(estimateTokens(m.content ?? "")).padStart(6)}t ${bar} ${preview}`);
  });
}
```

挂到 `onStep` 里每轮打印一次。你会立刻看到真相：哪条 8000 tokens 的工具结果占了半壁江山、哪段历史在滚雪球、压缩后摘要是不是把关键事实弄丢了。**Agent 的行为问题，多数时候是数据问题，数据就在 messages 里。**

## 练习

1. 实现 5.3 末尾说的"配对完整性校验"：压缩切分后检查 recent 首条若是孤立的 tool 消息，向前扩界。
2. 实现 5.4 的重复读取去重缓存。
3. 给你第 4 章练习的真实任务 agent 写一份四段式 system prompt，用 05-audit 观察它 10 轮内的上下文构成变化。
4. 挑战：实现"分级压缩"——距最近 N 条更远的、纯 tool 结果（无 assistant 判断介入的）单独替换为 `[已省略的 xx 工具结果]` 占位符，再对更旧的历史做摘要。观察对长任务质量的影响。

## 常见坑

- **只在爆 400 之后才做压缩**：那时你已经丢失了"从容摘要"的机会，且质量早已衰减。阈值 80%。
- **把 system prompt 一起压掉**：system 永远原样保留在最前（代码里已单独拎出）。
- **摘要模型 temperature 太高**：摘要是事实压缩，`temperature: 0`。
- **压缩后丢"数字与路径"**：摘要 prompt 里点名要求保留具体事实（文件路径、数量、错误码），否则摘要会变成正确的废话。
- **信任估算 tokens 超了就不压缩**：估算只是日常判断，每个响应的 `usage.prompt_tokens` 是实测，两者差值持续 >20% 时修正估算系数。

---

上一章：[第 4 章](04-tool-system.md) · 下一章：[第 6 章 · 记忆与检索](06-memory-and-rag.md)
