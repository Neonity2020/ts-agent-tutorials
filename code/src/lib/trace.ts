// 第 10 章 · Trace：一次任务的完整事件记录（JSONL，一行一个事件，可回放排障）
import { appendFile, mkdir } from "node:fs/promises";
import type { AgentEvent } from "./events";

export type TraceEvent =
  | AgentEvent
  | { type: "session_start"; meta?: Record<string, unknown> }
  | { type: "session_end"; meta?: Record<string, unknown> };

export class Tracer {
  private totalTokens = 0;
  private constructor(private readonly file: string) {}

  static async start(meta: Record<string, unknown> = {}): Promise<Tracer> {
    await mkdir("traces", { recursive: true });
    const id = new Date().toISOString().replace(/[:.]/g, "-");
    const t = new Tracer(`traces/${id}.jsonl`);
    await t.write({ type: "session_start", meta });
    return t;
  }

  async write(event: TraceEvent): Promise<void> {
    if (event.type === "usage") {
      this.totalTokens += event.promptTokens + event.completionTokens;
    }
    await appendFile(this.file, JSON.stringify({ ...event, ts: Date.now() }) + "\n");
  }

  get tokens(): number {
    return this.totalTokens;
  }
}
