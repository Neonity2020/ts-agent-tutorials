# 第 8 章 · 规划、审批与取消：给 Agent 装上方向盘和刹车

> 本章新增文件：`src/lib/approval.ts`、`src/lib/session.ts`、`src/demos/08-plan-execute.ts`

**本章你会学会：**

- plan-then-execute：先让模型交计划，批准后再执行
- 实现人工审批（human-in-the-loop）与权限模式
- 用 AbortSignal 做到"随时可停、停得干净"
- 会话持久化：崩溃/中断后接着跑

前面章节给 Agent 装了手（工具）和记忆（上下文/记忆），这一章装**方向盘和刹车**。任务越自主，控制越重要——这是把玩具变成可上生产系统的分水岭。

## 8.1 权限模式：一个枚举管住所有危险

多数 coding agent 都有类似的三档权限，我们也做一版：

```ts
export type PermissionMode = "readonly" | "ask" | "yolo";

export interface ToolPolicy {
  /** 工具名 → 风险等级 */
  riskOf: (toolName: string) => "safe" | "write" | "dangerous";
}
```

三档语义：

| 模式 | safe（读文件、grep） | write（写文件） | dangerous（执行命令、网络） |
|------|---------------------|-----------------|---------------------------|
| `readonly` | 放行 | 拒绝（工具不可用/执行时拒绝） | 拒绝 |
| `ask`（默认） | 放行 | 每次确认 | 每次确认 |
| `yolo` | 放行 | 放行 | 放行 |

> `src/lib/approval.ts`

```ts
import * as readline from "node:readline";
import type { ToolContext } from "./tools";
import type { PermissionMode } from "./types";

export function makeConfirm(mode: PermissionMode): NonNullable<ToolContext["confirm"]> {
  return async ({ action, detail }) => {
    if (mode === "yolo") return true;
    if (mode === "readonly") return false;
    return await askUser(`⚠ 需要 ${action}：${detail}，允许吗？[y/N/a=本次会话总是允许]`);
  };
}

let sessionAllowed = new Set<string>(); // "总是允许"的记忆粒度：按 action 类型

async function askUser(question: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await new Promise<string>((res) => rl.question(`${question} `, res));
    if (answer.trim().toLowerCase() === "a") {
      sessionAllowed.add(question); // 简化演示；实际应按 action 类型记录
      return true;
    }
    return answer.trim().toLowerCase() === "y";
  } finally {
    rl.close();
  }
}
```

接线：把 `makeConfirm(mode)` 塞进 `ToolContext`（第 4 章的 `write_file`、`run_command` 已会调它），Agent 从此有刹车。三个体验细节：

- **默认拒绝**（y/N）：拿不准时人天然倾向按回车，默认值必须是"不做"。
- **拒绝的信息回给模型**（第 4 章已做："操作被用户拒绝，请更换方案或询问用户"）——模型会换思路，而不是卡死重试。
- **"总是允许"按操作类型**：让用户对"写 src 下的文件"授权一次，而不是连续点 20 次 y。生产系统里这一层通常持久化成配置文件（`.agent-permissions.json`）。

> `readonly` 模式的另一种实现是**工具集隔离**：直接不给 agent 写类工具。比"给了但拒绝"更省 token（模型不会反复尝试），代价是不能在拒绝信息里引导模型。两者可并存：模式决定工具集，确认决定单次放行。

## 8.2 Plan-then-Execute：先看菜单再开火

自主循环的问题：模型可能一头扎进错误的执行路径，等你发现已经改了十个文件。**计划模式**把"决定干什么"和"动手干"拆成两个阶段，中间插一个人工卡点：

```ts
// 阶段一：规划——只给只读工具，逼它调研而不是动手
const planResult = await agentLoop(
  [{ role: "user", content: task }],
  {
    tools: readOnlyTools, // list_files / read_file / grep
    system:
      "你是规划者。调研现状后，用 submit_plan 工具提交计划。" +
      "计划必须包含：目标、步骤（每步标注涉及的文件/命令）、风险点、验证方式。",
    maxTurns: 12,
  },
);

// 阶段二：人工批准计划（终端 y/n/编辑）
const plan = planResult.answer; // 或从 submit_plan 的调用参数里取结构化版本（第 2 章技巧）
const approved = await askUser(`\n===== 计划 =====\n${plan}\n===== 按此执行？[y/N] =====`);
if (!approved) process.exit(0);

// 阶段三：执行——带着计划全文进入完整工具集
const execResult = await agentLoop(
  [
    { role: "user", content: `按以下已批准的计划执行：\n${plan}\n\n执行中若发现计划不可行，停下来说明，不要自行改目标。` },
  ],
  { tools: fullTools, system: execSystem, maxTurns: 40 },
);
```

三个关键点：

1. **规划阶段拿走写类工具**，模型物理上无法抢跑。这比在 prompt 里写"先不要动手"可靠一万倍——prompt 会被忽略，工具集不会。
2. **计划文本要原样带进执行阶段**（就是执行阶段的"任务描述"），否则执行 Agent 对计划一无所知。
3. **"发现计划不可行要停下"是重要的红线**。默认倾向是模型硬着头皮歪着走完计划；明确授权它报告偏差。

这个模式的成本是多一次模型往返和一次人工等待，换来的是**方向错误在零损失时被拦截**。改动越大、风险越高的任务，越值得先 plan。日常小事直接 `ask` 模式跑即可。

## 8.3 取消：AbortSignal 一贯到底

第 1 章埋的 AbortController 在这里收网。目标：用户 Ctrl+C，**模型请求和正在执行的工具都要立刻停**，且退出前有清场机会。

```ts
// src/demos/08-plan-execute.ts 骨架
const controller = new AbortController();

process.on("SIGINT", () => {
  if (controller.signal.aborted) {
    console.error("\n再次中断，强制退出");
    process.exit(130);
  }
  controller.abort(new Error("用户中断"));
  console.error("\n正在取消当前步骤…（再按一次强制退出）");
});

try {
  const result = await agentLoop(messages, {
    tools: fullTools,
    signal: controller.signal, // AgentOptions 增加 signal，透传给 chat 与 runToolCall 的 ctx
  });
} catch (e) {
  if (controller.signal.aborted) {
    await saveSession(messages); // 清场：保存现场，下次可恢复（下一节）
    console.error("已中断，会话已保存");
    process.exit(130);
  }
  throw e;
}
```

需要改造的两处（都是把 signal 穿进去）：

- `agentLoop` / `chat`：第 1 章已支持 `opts.signal`。
- `runToolCall`：第 4 章的 `ctx.signal` 已接 `withTimeout` 的 abort 监听——**取消与超时共用同一条机制**，这是 AbortSignal 设计的妙处。

一个纪律：**工具内部自己起的子进程/子请求也必须接收这个 signal**（`execFile` 有 `signal` 选项、`fetch` 有 `signal`），否则"取消"只是取消了等待，活儿还在后台跑。

> 双层中断的设计（第一次优雅取消 + 第二次强制退出）来自真实产品的通行实践——优雅取消可能被卡住的子进程拖住，用户永远需要逃生舱。

## 8.4 会话持久化与恢复

长任务跑一半挂了（崩溃、中断、关机），从头再来既费钱又可能重复危险操作。方案朴素：**把 messages 落盘，恢复时载入续跑**。

> `src/lib/session.ts`

```ts
import { mkdir, readFile, writeFile } from "node:fs/promises";
import type { ChatMessage } from "./llm";

const SESSION_DIR = ".agent-sessions";

export async function saveSession(messages: ChatMessage[], meta: Record<string, unknown> = {}) {
  await mkdir(SESSION_DIR, { recursive: true });
  const id = `session-${Date.now()}.json`;
  await writeFile(`${SESSION_DIR}/${id}`, JSON.stringify({ messages, meta, savedAt: new Date().toISOString() }, null, 2));
  return id;
}

export async function loadSession(id: string): Promise<ChatMessage[]> {
  const data = JSON.parse(await readFile(`${SESSION_DIR}/${id}`, "utf8"));
  return data.messages;
}
```

恢复续跑的核心技巧是**追加一条 user 消息作为"接力棒"**：

```ts
const messages = await loadSession(sessionId);
messages.push({
  role: "user",
  content: "会话从上次中断处恢复。请先用工具核实你的当前进度（上下文可能已过期），然后继续完成原任务。",
});
await agentLoop(messages, { tools: fullTools });
```

为什么不能直接续跑？因为中断点可能停在"模型刚说要调工具、工具还没执行"的半截状态——messages 尾部是悬空的 `tool_calls`，直接发请求会 400。追加 user 消息一举两得：修复配对，同时让模型先自查状态再行动。**恢复的可靠性靠"核实"，不靠"信任历史"。**

## 8.5 把控制流拼成模式总表

到此，你的 Agent 拥有完整的控制谱系。按任务风险选用：

| 场景 | 配置 |
|------|------|
| 只读问答/调研 | `readonly` 模式（只给只读工具）+ 单循环 |
| 日常小修改 | `ask` 模式 + 单循环 |
| 大改动/生产环境 | plan-then-execute + `ask` + 会话持久化 |
| 无人值守批处理 | `yolo` + 沙箱目录 + 严格的工具白名单 + 硬性 maxTurns + 全量 trace（第 10 章） |

注意最后一行：**yolo 从不等于裸奔**。无人值守时，权限模式外移给了环境（容器/沙箱目录/白名单），因为没有人可以按 y 了。

## 练习

1. 实现持久化的权限记忆：`ask` 模式下用户选 `a` 后，把 `{action, pattern}` 写入 `.agent-permissions.json`，下次启动加载。pattern 至少要支持路径前缀匹配（如 `src/**`）。
2. 把 8.2 的计划阶段升级为结构化输出：`submit_plan` 工具（第 2 章技巧），计划变成可校验的 JSON；执行阶段把"当前进行到第几步"实时回填给模型。
3. 给 `saveSession` 加"消息裁剪"：存盘前把超过 MAX_RESULT_CHARS 的历史工具结果替换成 `[已存档: <hash>]`，并把完整内容写进旁边的 `attachments/` 目录。想清楚恢复时怎么处理（提示：惰性物化——模型要时再给个 `read_attachment` 工具）。
4. 挑战：实现"每步暂停"模式（步进调试 Agent）：每轮工具调用前打印将要执行的动作并等确认。你刚造了一个 Agent 调试器。

## 常见坑

- **yolo 模式 + 有写权限的 LLM 循环 + 无人值守**：这是事故配方。三样凑齐前，至少去掉一样。
- **确认对话框在批量操作里出现 50 次**：没有"总是允许"粒度的确认系统会被用户禁用——易用性是安全机制生效的前提。
- **计划阶段和执行阶段用了不同的模型/参数**：计划与执行能力不匹配会出现"计划做得出、执行做不了"。
- **SIGINT 只 abort 了 fetch**：工具内的子进程还在跑。统一用 ctx.signal 穿透（8.3 纪律）。
- **恢复会话直接续跑**：悬空 tool_calls 导致 400，或模型带着过期状态自信干活。永远让恢复的第一步是"核实"。

---

上一章：[第 7 章](07-multi-agent.md) · 下一章：[第 9 章 · 流式解析与终端体验](09-streaming-ui.md)
