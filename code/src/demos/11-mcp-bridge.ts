// 第 11 章示例：把 MCP server 的工具桥接进自己的 Agent
// 用法：npx tsx src/demos/11-mcp-bridge.ts
import { agentLoop } from "../lib/agent";
import { connectMcpBridge } from "../lib/mcp";

console.log("正在拉起 MCP server（子进程）…");
const bridge = await connectMcpBridge({
  name: "text-tools",
  command: "npx",
  args: ["tsx", "src/mcp/word-count-server.ts"],
});
console.log("MCP 工具:", bridge.tools.map((t) => t.name).join(", "));
try {

const result = await agentLoop(
  [{ role: "user", content: "把这句话转成 slug：Hello MCP World，然后统计转换结果的字符数" }],
  {
    tools: bridge.tools,
    maxTurns: 8,
    emit: (e) => {
      if (e.type === "tool_call_start") console.log(`▸ ${e.name} ${e.argsPreview.slice(0, 60)}`);
    },
  },
);
  console.log(`\n${result.answer}`);
} finally {
  await bridge.close(); // 关闭 MCP server 子进程，否则本进程不会退出
}
