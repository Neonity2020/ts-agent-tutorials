// 第 11 章 · MCP 客户端桥接：连接 MCP server，把它的全部工具桥接成我们的 DefinedTool
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { z } from "zod";
import type { AnyTool } from "./tools";

export interface McpServerConfig {
  name: string;
  command: string; // 如 "npx" 或 "node"
  args?: string[]; // 如 ["tsx", "src/mcp/word-count-server.ts"]
  env?: Record<string, string>; // 敏感凭据走 env，不要放 args（进程列表可见）
}

export interface McpBridge {
  tools: AnyTool[];
  /** 关闭 MCP server 子进程；跑完即退的脚本若不调用，进程会因子进程未退出而挂起 */
  close: () => Promise<void>;
}

export async function connectMcpBridge(cfg: McpServerConfig): Promise<McpBridge> {
  const transport = new StdioClientTransport({
    command: cfg.command,
    args: cfg.args ?? [],
    env: cfg.env ? { ...cfg.env } : undefined,
  });
  const client = new Client({ name: "my-ts-agent", version: "1.0.0" });
  await client.connect(transport); // initialize 握手

  const { tools } = await client.listTools(); // tools/list

  // 手工构造 DefinedTool：parameters 直接用 MCP 提供的 inputSchema，
  // 不要经 z.toJSONSchema 转换（z.custom 生成不出有意义的 schema）
  const bridged: AnyTool[] = tools.map((t) => ({
    name: t.name,
    description: t.description ?? `(MCP 工具 ${t.name}，无描述)`,
    parameters: (t.inputSchema ?? { type: "object", properties: {} }) as Record<string, unknown>,
    schema: z.custom<Record<string, unknown>>((v) => typeof v === "object"),
    execute: async (args: Record<string, unknown>) => {
      // callTool 在 SDK 泛型默认下返回值较宽，显式收窄我们用到的字段
      const result = (await client.callTool({ name: t.name, arguments: args })) as {
        content?: Array<{ type: string; text?: string }>;
        isError?: boolean;
      };
      const text = (result.content ?? [])
        .map((c) => (c.type === "text" ? (c.text ?? "") : `[${c.type}]`))
        .join("\n");
      return result.isError ? `ERROR: ${text}` : text;
    },
  }));
  return {
    tools: bridged,
    close: async () => {
      try {
        await client.close();
      } catch {
        // server 可能已自行退出
      }
      await transport.close();
    },
  };
}

/** 教学最简版（与第 11 章正文签名一致）：只要工具数组。一次性脚本请改用 connectMcpBridge 并在结束时 close()。 */
export async function connectMcpTools(cfg: McpServerConfig): Promise<AnyTool[]> {
  return (await connectMcpBridge(cfg)).tools;
}
