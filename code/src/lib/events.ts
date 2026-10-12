// 第 9 章 · 统一事件协议：UI、trace、SSE 前端消费同一份事件流
export type AgentEvent =
  | { type: "turn_start"; turn: number }
  | { type: "text_delta"; delta: string }
  | { type: "tool_call_start"; name: string; argsPreview: string }
  | { type: "tool_result"; name: string; result: string; ok: boolean; durationMs: number }
  | { type: "usage"; promptTokens: number; completionTokens: number }
  | { type: "compact"; before: number; after: number }
  | { type: "turn_end"; turn: number };
