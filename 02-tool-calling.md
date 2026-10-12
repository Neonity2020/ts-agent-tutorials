# 第 2 章 · 工具调用（Function Calling）

> 本章修改文件：`src/lib/llm.ts`（chat 支持传工具）
> 本章新增文件：`src/demos/02-weather.ts`、`src/demos/02-extract.ts`

**本章你会学会：**

- 工具调用的完整协议：定义 → 点名 → 执行 → 回填 → 续答
- 理解一个关键事实：**模型从不执行代码，它只输出"请帮我调 X，参数是 Y"**
- 处理参数幻觉与格式错误
- 用工具调用做结构化输出

## 2.1 核心心智模型

LLM 是个文本生成器，它没有手，跑不了函数。所谓"模型调用工具"，实际发生的是这个四步循环（**执行者始终是你**）：

```
┌─ 1. 请求时带上工具清单（JSON Schema 描述）
│  2. 模型不回答问题，而是回复 tool_calls：调哪个工具 + JSON 参数
│  3. 你的代码解析参数、真正执行函数
└─ 4. 把执行结果以 role:"tool" 消息回填，再请求 → 模型基于结果作答
```

把这个循环在心里跑顺了，第 3 章的 Agent 循环就是给它套个 `while`。

## 2.2 定义工具

工具 = 名字 + 描述 + JSON Schema 参数 + 你的实现。先手工写一遍 schema，下一章再交给 Zod：

```ts
const weatherTool = {
  type: "function",
  function: {
    name: "get_weather",
    description: "查询一个城市当前的天气。当用户问到天气、气温、出行穿衣建议时使用。",
    parameters: {
      type: "object",
      properties: {
        city: { type: "string", description: "城市名，如：北京" },
        unit: { type: "string", enum: ["celsius", "fahrenheit"], description: "温度单位，默认 celsius" },
      },
      required: ["city"],
    },
  },
} as const;
```

`description` 不是注释，是**给模型读的 API 文档**。模型完全根据名字和描述来决定"这个场景该不该调这个工具、参数填什么"。写得含糊，调用就离谱。原则：

- 描述写"什么时候用我"，而不只是"我是什么"；
- 每个参数都写描述，枚举值说清每个取值的含义；
- 别堆几十个工具——工具越多，选错的概率越高（第 4 章细讲）。

## 2.3 完整的一轮工具调用

先把 `chat()` 扩展成支持工具（追加 `tools` 选项，其余不变）：

```ts
// src/lib/llm.ts 中给 ChatOptions 增加：
export interface ChatOptions {
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  tools?: unknown[]; // 工具清单，直接透传给 API
}
// body: JSON.stringify({ ... 原有字段 ..., tools: opts.tools })
```

> `src/demos/02-weather.ts` —— 完整四步：

```ts
import { chat, type ChatMessage } from "../lib/llm";

// 第 0 步：工具的"你的实现"
async function getWeather(args: { city: string; unit?: string }) {
  // 真项目里这里是调天气 API；演示就造假数据
  return {
    city: args.city,
    temp: args.unit === "fahrenheit" ? 86 : 30,
    condition: "晴",
    unit: args.unit ?? "celsius",
  };
}

const messages: ChatMessage[] = [
  { role: "system", content: "你是天气助手，回答简洁。" },
  { role: "user", content: "北京今天多少度？适合穿什么？" },
];

// 第 1 步：带工具清单发起请求
let { message } = await chat(messages, { tools: [weatherTool] });
messages.push(message);

// 第 2 步：模型可能不答问题，而是点名要调工具
if (message.tool_calls?.length) {
  for (const call of message.tool_calls) {
    console.log(`→ 模型想调: ${call.function.name}(${call.function.arguments})`);

    // 第 3 步：解析参数并执行（执行者是你，不是模型！）
    const args = JSON.parse(call.function.arguments);
    const result = await getWeather(args);

    // 第 4 步：把结果作为 role:"tool" 消息回填
    messages.push({
      role: "tool",
      tool_call_id: call.id, // 必须对上，模型靠 id 知道结果对应哪次调用
      content: JSON.stringify(result),
    });
  }

  // 第 5 步：带着工具结果再问一次，模型这才组织出面向用户的回答
  ({ message } = await chat(messages, { tools: [weatherTool] }));
  messages.push(message);
}

console.log(message.content);
// → 模型想调: get_weather({"city":"北京"})
// 北京今天 30°C，晴。建议穿轻薄透气的衣物，注意防晒。
```

跑一下，重点观察打印出的那行 `→ 模型想调:`——模型输出的不是答案，是一次函数调用请求。

**多工具并行**：模型可以在一条消息里返回多个 `tool_calls`（比如用户问"北京和上海天气"），所以协议里是数组，处理时逐个执行、逐个回填，每个都要带自己的 `tool_call_id`。

## 2.4 参数不可信：错误处理三原则

模型的 JSON 输出是"生成"出来的，不是校验过的，可能缺字段、错类型、编造枚举值（参数幻觉）。三条铁律：

**1. 解析必须 try/catch，且错误要回给模型而不是抛给用户。**

```ts
let args: unknown;
try {
  args = JSON.parse(call.function.arguments || "{}");
} catch (e) {
  // 不抛出！把错误作为工具结果回填，模型会自行纠正重试
  messages.push({
    role: "tool",
    tool_call_id: call.id,
    content: `ERROR: arguments 不是合法 JSON：${(e as Error).message}`,
  });
  continue;
}
```

**2. 参数必须过校验（下一章用 Zod 彻底解决），不合格同样回给模型。**

**3. 工具内部失败也回给模型，格式统一、信息可行动：**

```ts
// 差：'Error: ECONNREFUSED'
// 好：模型知道该怎么办
"ERROR: 天气服务暂不可用（连接被拒绝）。可以告知用户当前无法查询天气，或稍后重试。"
```

这个模式叫**错误自愈**：工具层把失败变成模型可读的信息，让模型决定重试、换路还是告诉用户。第 4 章会把它做进工具执行器的默认行为。

## 2.5 结构化输出：让模型输出可靠 JSON

Agent 开发的高频需求：让模型按固定结构输出（抽发票字段、生成配置、给子任务拆解）。两种做法：

**方案 A：JSON mode**——请求加 `response_format: { type: "json_object" }`，模型保证输出合法 JSON。简单，但**无法约束字段和类型**，还是要自己校验。

**方案 B（推荐）：定义一个"提取工具"，逼模型以工具调用形式输出。** 工具 schema 本身就是完整约束，参数错误还能走 2.4 的自愈循环：

> `src/demos/02-extract.ts`

```ts
import { z } from "zod";
import { chat, type ChatMessage } from "../lib/llm";

const Invoice = z.object({
  seller: z.string().describe("开票方名称"),
  amount: z.number().describe("价税合计，数字，不带单位"),
  date: z.string().describe("开票日期，YYYY-MM-DD"),
});
type Invoice = z.infer<typeof Invoice>; // { seller: string; amount: number; date: string }

const extractInvoice = {
  type: "function",
  function: {
    name: "record_invoice",
    description: "从文本中提取发票信息后调用此工具登记",
    parameters: z.toJSONSchema(Invoice), // Zod v4 内置 JSON Schema 转换
  },
};

const text = `今收到星辰科技开具的增值税发票一张，金额合计 12,800.00 元（含税），
开票日期 2026 年 8 月 17 日，货物为服务器托管服务。`;

const messages: ChatMessage[] = [{ role: "user", content: `提取发票信息：\n${text}` }];
let { message } = await chat(messages, { tools: [extractInvoice] });

if (message.tool_calls?.length) {
  const args = JSON.parse(message.tool_calls[0].function.arguments);
  const invoice = Invoice.parse(args); // Zod 校验：通过则类型可信，失败则回给模型重试
  console.log(invoice);
  // { seller: '星辰科技', amount: 12800, date: '2026-08-17' }
}
```

这就是 Zod 在 Agent 技术栈里的核心地位：**模型输出（不可信）→ Zod parse（校验+ narrowing）→ 类型安全的 TS 对象（可信）**。`z.toJSONSchema()` 则让"一份 schema 同时喂模型和编译器"成为可能——第 4 章的 `defineTool` 就建立在这上面。

> 兼容性备注：`z.toJSONSchema()` 是 Zod v4 的 API。若服务商对 JSON Schema 版本挑剔，可传 `z.toJSONSchema(schema, { target: "draft-7" })`。

## 练习

1. 给天气 agent 增加 `get_time`（返回当前时间）和 `calculator`（四则运算，用 `Function` 实现 `eval` 太危险，可以用 `expr-eval` 库或自己写个安全求值）两个工具，问它"北京现在适合洗车吗"，观察它是否自主串联多个工具。
2. 用方案 B 写一个"会议纪要 → 结构化待办"的提取器：schema 至少包含 `title`、`owner`、`due_date`，其中 `due_date` 要求输出 ISO 格式（试试模型会不会把"下周五"直接编个日期——然后想想 description 里该怎么写规则才能防止）。
3. 故意把工具描述删掉只留函数名，看模型调用质量下降多少。这个实验的结论会贯穿全书：**工具的 description 就是 prompt**。

## 常见坑

- **忘记回填 tool 结果就继续请求**：API 会报 400（tool_call 必须有对应的 tool 消息）。
- **`tool_call_id` 对不上**：并行多个调用时回填错位，模型会把 A 的结果安到 B 头上。
- **在 execute 里抛异常**：异常会击穿整个请求流程；正确做法是 catch 后把错误文本回填（2.4）。
- **schema 里用模型不认识的业务黑话**：描述是写给模型的，按"新人第一天上岗"的标准写。
- **模型不调工具直接瞎答**：九成是 description 没写清使用场景；必要时在 system prompt 里补一句"涉及 X 时必须先调用 Y"。

---

上一章：[第 1 章](01-first-llm-call.md) · 下一章：[第 3 章 · Agent 循环](03-agent-loop.md)
