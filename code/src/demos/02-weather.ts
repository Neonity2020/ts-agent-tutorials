// 第 2 章示例：完整的一轮工具调用（原理演示，手工 JSON Schema 版）
import { chat, type ChatMessage } from "../lib/llm";

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
    messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result) });
  }

  // 第 5 步：带着工具结果再问一次，模型这才组织出面向用户的回答
  ({ message } = await chat(messages, { tools: [weatherTool] }));
  messages.push(message);
}

console.log(message.content);
