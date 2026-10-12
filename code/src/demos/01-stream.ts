// 第 1 章示例：流式输出（打字机效果）
import { chatStream } from "../lib/llm";

const answer = await chatStream(
  [{ role: "user", content: "用 300 字讲讲什么是上下文窗口" }],
  (delta) => process.stdout.write(delta), // 每收到一小段立刻打印
);
process.stdout.write("\n");
