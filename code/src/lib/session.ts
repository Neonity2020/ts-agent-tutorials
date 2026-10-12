// 第 8 章 · 会话持久化与恢复：messages 落盘，崩溃/中断后可续跑
import { mkdir, readFile, writeFile } from "node:fs/promises";
import type { ChatMessage } from "./llm";

const SESSION_DIR = ".agent-sessions";

export async function saveSession(
  messages: ChatMessage[],
  meta: Record<string, unknown> = {},
): Promise<string> {
  await mkdir(SESSION_DIR, { recursive: true });
  const id = `session-${Date.now()}.json`;
  await writeFile(
    `${SESSION_DIR}/${id}`,
    JSON.stringify({ messages, meta, savedAt: new Date().toISOString() }, null, 2),
  );
  return id;
}

export async function loadSession(id: string): Promise<ChatMessage[]> {
  const data = JSON.parse(await readFile(`${SESSION_DIR}/${id}`, "utf8"));
  return data.messages as ChatMessage[];
}
