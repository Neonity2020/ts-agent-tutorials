// 第 10 章 · 最小 eval runner：任务数据集 + runner + 判分 + 报告
// 用法：npx tsx evals/run.ts [caseId]（只跑某个用例）
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { agentLoop } from "../src/lib/agent";
import { basicTools, readOnlyTools, ensureNotes } from "../src/demos/shared";
import type { AnyTool } from "../src/lib/tools";
import type { PermissionMode } from "../src/lib/types";

interface Case {
  id: string;
  task: string;
  mode?: PermissionMode;
  expect: {
    includes?: string[]; // 最终答案必须包含
    excludes?: string[]; // 最终答案必须不包含
    toolsUsed?: string[]; // 必须用过这些工具
    notToolsUsed?: string[]; // 禁止使用这些工具
    maxTurns?: number;
  };
}

interface CaseResult {
  id: string;
  pass: boolean;
  failures: string[];
  turns: number;
  tokens: number;
  seconds: number;
}

const PRICE_USD_PER_1K_TOKENS = 0.0001; // 示例单价：按你的服务商价格修改
const estimateCost = (tokens: number) => (tokens / 1000) * PRICE_USD_PER_1K_TOKENS;
const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

function toolsFor(mode: PermissionMode): AnyTool[] {
  return mode === "readonly" ? readOnlyTools() : basicTools();
}

async function runCase(c: Case): Promise<CaseResult> {
  const usedTools = new Set<string>();
  let tokens = 0;
  const t0 = Date.now();

  try {
    const result = await agentLoop([{ role: "user", content: c.task }], {
      tools: toolsFor(c.mode ?? "yolo"),
      maxTurns: c.expect.maxTurns ?? 20,
      ctx: { confirm: async () => (c.mode ?? "yolo") !== "readonly" }, // 评测跑在沙箱目录里
      emit: (e) => {
        if (e.type === "tool_result") usedTools.add(e.name);
        if (e.type === "usage") tokens += e.promptTokens + e.completionTokens;
      },
    });

    const failures: string[] = [];
    for (const s of c.expect.includes ?? []) if (!result.answer.includes(s)) failures.push(`答案缺少 "${s}"`);
    for (const s of c.expect.excludes ?? []) if (result.answer.includes(s)) failures.push(`答案不应包含 "${s}"`);
    for (const t of c.expect.toolsUsed ?? []) if (!usedTools.has(t)) failures.push(`未使用工具 ${t}`);
    for (const t of c.expect.notToolsUsed ?? []) if (usedTools.has(t)) failures.push(`违规使用工具 ${t}`);
    if (result.stopReason !== "completed") failures.push(`异常终止: ${result.stopReason}`);
    if (c.expect.maxTurns && result.turns > c.expect.maxTurns) failures.push(`超步数 ${result.turns}`);

    return {
      id: c.id,
      pass: failures.length === 0,
      failures,
      turns: result.turns,
      tokens,
      seconds: (Date.now() - t0) / 1000,
    };
  } catch (e) {
    return {
      id: c.id,
      pass: false,
      failures: [` threw: ${(e as Error).message}`],
      turns: 0,
      tokens,
      seconds: (Date.now() - t0) / 1000,
    };
  }
}

async function main() {
  await ensureNotes();
  const only = process.argv[2];
  const cases: Case[] = (await readFile("evals/cases.jsonl", "utf8"))
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));

  const results: CaseResult[] = [];
  for (const c of cases) {
    if (only && c.id !== only) continue;
    process.stdout.write(`▶ ${c.id} … `);
    const r = await runCase(c);
    console.log(r.pass ? "✓" : `✗ ${r.failures.join("; ")}`);
    results.push(r);
  }

  const summary = {
    total: results.length,
    passed: results.filter((r) => r.pass).length,
    avgTurns: avg(results.map((r) => r.turns)),
    avgTokens: avg(results.map((r) => r.tokens)),
    estCostUsd: results.reduce((s, r) => s + estimateCost(r.tokens), 0),
  };

  await mkdir("evals/runs", { recursive: true });
  const out = `evals/runs/${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  await writeFile(out, JSON.stringify({ results, summary }, null, 2));
  console.log(
    `\n通过 ${summary.passed}/${summary.total} ｜ 平均 ${summary.avgTurns.toFixed(1)} 轮 ｜ ` +
      `平均 ${Math.round(summary.avgTokens)} tokens ｜ 预估 $${summary.estCostUsd.toFixed(4)}\n详情：${out}`,
  );
}

main();
