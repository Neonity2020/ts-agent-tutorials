// 第 11 章 · MCP server 示例：一个最小但完整的 stdio server
// 注意：stdout 是协议专线，日志必须走 console.error！
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "text-tools", version: "1.0.0" });

server.registerTool(
  "word_count",
  {
    description: "统计一段文本的字符数与行数",
    inputSchema: { text: z.string().describe("要统计的文本") },
  },
  async ({ text }) => ({
    content: [{ type: "text" as const, text: `字符数 ${text.length}，行数 ${text.split("\n").length}` }],
  }),
);

server.registerTool(
  "slugify",
  {
    description: "把标题转成 URL slug（小写、空格变分隔符）",
    inputSchema: { title: z.string(), separator: z.string().default("-") },
  },
  async ({ title, separator }) => ({
    content: [{ type: "text" as const, text: title.trim().toLowerCase().replace(/\s+/g, separator) }],
  }),
);

// stdio 传输：本进程的 stdin/stdout 就是与 client 的通信管道
await server.connect(new StdioServerTransport());
console.error("text-tools MCP server ready");
