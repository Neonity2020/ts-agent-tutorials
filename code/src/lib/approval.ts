// 第 8 章 · 人工审批：终端 y/N/a 确认，"a" 按 action 类型记住本次会话的授权
import * as readline from "node:readline";
import type { ToolContext } from "./tools";
import type { PermissionMode } from "./types";

export function makeConfirm(mode: PermissionMode): NonNullable<ToolContext["confirm"]> {
  const alwaysAllowed = new Set<string>();
  return async ({ action, detail }) => {
    if (mode === "yolo") return true;
    if (mode === "readonly") return false;
    if (alwaysAllowed.has(action)) return true;
    const answer = await askUser(`⚠ 需要 ${action}：${detail} [y/N/a=本次会话总是允许] `);
    if (answer === "a") {
      alwaysAllowed.add(action);
      return true;
    }
    return answer === "y";
  };
}

async function askUser(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await new Promise<string>((res) => rl.question(question, res))).trim().toLowerCase();
  } finally {
    rl.close();
  }
}
