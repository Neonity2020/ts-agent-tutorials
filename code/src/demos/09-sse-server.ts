// 第 9 章示例：把 Agent 包成 SSE 服务（供 Web 前端消费事件流）
// 用法：npx tsx src/demos/09-sse-server.ts
// 测试：curl -N -X POST localhost:8080/agent -d '{"task":"看看 notes 里有什么"}'
import { createServer } from "node:http";
import { agentLoop } from "../lib/agent";
import { readOnlyTools, ensureNotes } from "./shared";

await ensureNotes();

createServer(async (req, res) => {
  if (req.method !== "POST" || req.url !== "/agent") {
    res.writeHead(404).end();
    return;
  }

  const { task } = await new Promise<{ task: string }>((r) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => r(JSON.parse(body || "{}")));
  });
  if (!task) {
    res.writeHead(400).end('{"error":"task required"}');
    return;
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  try {
    const result = await agentLoop([{ role: "user", content: task }], {
      tools: readOnlyTools(), // 演示服务只开只读工具；写操作务必接审批（第 8 章）
      maxTurns: 12,
      emit: (e) => {
        if (e.type === "text_delta") send("text_delta", { delta: e.delta });
        if (e.type === "tool_call_start") send("tool_call_start", { name: e.name, argsPreview: e.argsPreview });
        if (e.type === "tool_result") send("tool_result", { name: e.name, result: e.result.slice(0, 500), ok: e.ok });
      },
    });
    send("done", { answer: result.answer, stopReason: result.stopReason });
  } catch (e) {
    send("error", { message: (e as Error).message });
  } finally {
    res.end();
  }
}).listen(8080, () => {
  console.log("SSE agent on http://localhost:8080");
  console.log(`测试：curl -N -X POST localhost:8080/agent -d '{"task":"看看 notes 里有什么"}'`);
});
