// 第 2、4 章 · 工具系统：defineTool（Zod schema 一份三用）+ runToolCall（校验/超时/截断/错误自愈）
import { z } from "zod";
import type { ToolCall } from "./llm";

export const DEFAULT_TOOL_TIMEOUT_MS = 30_000;
export const MAX_RESULT_CHARS = 8_000;

/** 执行上下文：工具需要的能力通过 ctx 注入，而不是各自去摸全局 */
export interface ToolContext {
  signal?: AbortSignal;
  /** 危险操作确认钩子（第 8 章）；默认放行 */
  confirm?: (req: { action: string; detail: string }) => Promise<boolean>;
}

export interface DefinedTool<S extends z.ZodType> {
  name: string;
  description: string;
  /** 喂给模型的 JSON Schema（由 Zod 自动生成） */
  parameters: Record<string, unknown>;
  schema: S;
  execute: (args: z.infer<S>, ctx: ToolContext) => Promise<string>;
}

/** 任意具体化 DefinedTool（泛型擦除后放入工具数组用） */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyTool = DefinedTool<any>;

/**
 * 类型安全的工具定义：
 * - 模型看到的 JSON Schema 从 Zod 自动生成
 * - execute 入参自动获得 z.infer<S> 类型
 * - 参数校验和错误回填在 runToolCall 里统一做
 */
export function defineTool<S extends z.ZodType>(def: {
  name: string;
  description: string;
  schema: S;
  execute: (args: z.infer<S>, ctx: ToolContext) => Promise<string>;
}): DefinedTool<S> {
  return { ...def, parameters: z.toJSONSchema(def.schema) as Record<string, unknown> };
}

/** 统一执行入口：查表 → 解析 → Zod 校验 → 超时/取消 → 截断 → 错误自愈（错误文本回给模型） */
export async function runToolCall(
  call: ToolCall,
  tools: AnyTool[],
  ctx: ToolContext = {},
): Promise<string> {
  const tool = tools.find((t) => t.name === call.function.name);
  if (!tool) {
    return `ERROR: 未知工具 "${call.function.name}"。可用工具：${tools.map((t) => t.name).join(", ")}`;
  }

  let raw: unknown;
  try {
    raw = call.function.arguments ? JSON.parse(call.function.arguments) : {};
  } catch (e) {
    return `ERROR: 参数不是合法 JSON（${(e as Error).message}）。请修正后重新调用。`;
  }

  const parsed = tool.schema.safeParse(raw);
  if (!parsed.success) {
    const issues = (parsed.error.issues as Array<{ path: (string | number)[]; message: string }>)
      .map((i) => `- ${i.path.join(".") || "(根)"}: ${i.message}`)
      .join("\n");
    return `ERROR: 参数校验失败：\n${issues}\n请根据 schema 修正参数后重试。`;
  }

  try {
    const result = await withTimeout(tool.execute(parsed.data, ctx), ctx, DEFAULT_TOOL_TIMEOUT_MS);
    return result.length > MAX_RESULT_CHARS
      ? result.slice(0, MAX_RESULT_CHARS) + "\n…(结果过长已截断)"
      : result;
  } catch (e) {
    if (ctx.signal?.aborted) throw e; // 用户主动取消要继续上抛，不能被吞成工具错误
    return `ERROR: 工具 ${tool.name} 执行失败：${(e as Error).message}`;
  }
}

/** 同时挂「工具级超时」与「外部取消」两个信号源 */
function withTimeout<T>(p: Promise<T>, ctx: ToolContext, ms: number): Promise<T> {
  const timeoutSignal = AbortSignal.timeout(ms);
  return Promise.race([
    p,
    new Promise<never>((_, rej) => {
      timeoutSignal.addEventListener("abort", () => rej(new Error(`工具执行超时（${ms}ms）`)), { once: true });
      ctx.signal?.addEventListener("abort", () => rej(ctx.signal?.reason ?? new Error("已取消")), { once: true });
    }),
  ]);
}
