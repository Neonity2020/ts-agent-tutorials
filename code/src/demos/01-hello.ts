// 第 1 章示例：最基础的一次模型调用
import { chat } from "../lib/llm";

const { message, usage } = await chat([
  { role: "system", content: "你是一个简洁的助手，回答不超过两句话。" },
  { role: "user", content: "用一句话解释什么是递归" },
]);

console.log(message.content);
console.log(`（消耗 ${usage.total_tokens} tokens）`);
