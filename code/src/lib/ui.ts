// 第 9 章 · 终端渲染：spinner / 流式思考淡显 / 工具调用高亮 / 结果一行摘要
import type { AgentEvent } from "./events";

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export class AgentUI {
  private thinking = false;
  private spinnerTimer?: NodeJS.Timeout;
  private spinnerFrame = 0;
  private spinnerLabel = "";

  /** 统一入口：把 AgentEvent 直接喂给 UI（配合 agentLoop 的 emit） */
  handle(e: AgentEvent): void {
    switch (e.type) {
      case "turn_start":
        this.startSpinner("思考中");
        break;
      case "text_delta":
        this.stopSpinner();
        this.onText(e.delta);
        break;
      case "tool_call_start":
        this.stopSpinner();
        this.endText();
        this.onToolStart(e.name, e.argsPreview);
        break;
      case "tool_result":
        this.onToolResult(e.name, e.result, e.durationMs);
        break;
      case "compact":
        this.stopSpinner();
        this.endText();
        this.system(`上下文已压缩 ${e.before} → ${e.after} tokens`);
        break;
      default:
        break;
    }
  }

  /** 流式文本：淡显逐字输出 */
  onText(delta: string): void {
    if (!this.thinking) {
      process.stdout.write(dim("· "));
      this.thinking = true;
    }
    process.stdout.write(dim(delta));
  }

  endText(): void {
    if (this.thinking) {
      process.stdout.write("\n");
      this.thinking = false;
    }
  }

  /** 工具调用开始：高亮一行 */
  onToolStart(name: string, argsPreview: string): void {
    this.endText();
    process.stdout.write(`${cyan("▸")} ${bold(name)} ${dim(argsPreview.slice(0, 80))}\n`);
  }

  /** 工具结果：一行摘要；错误红叉、慢调用黄色警示 */
  onToolResult(name: string, result: string, durationMs?: number): void {
    const oneLine = result.replace(/\s+/g, " ").trim();
    const isErr = result.startsWith("ERROR");
    const cost = durationMs !== undefined ? `（${durationMs}ms）` : "";
    const slow = (durationMs ?? 0) > 5000 ? yellow("  ⏱>5s") : "";
    const ellipsis = oneLine.length > 100 ? dim(" …") : "";
    process.stdout.write(
      `  ${isErr ? red("✗") : green("✓")} ${name}${cost} ${dim(oneLine.slice(0, 100))}${ellipsis}${slow}\n`,
    );
  }

  system(msg: string): void {
    this.endText();
    process.stdout.write(`${dim(`── ${msg} ──`)}\n`);
  }

  startSpinner(label: string): void {
    if (this.spinnerTimer) return;
    this.spinnerLabel = label;
    this.spinnerTimer = setInterval(() => {
      const frame = cyan(SPINNER_FRAMES[this.spinnerFrame++ % SPINNER_FRAMES.length]);
      process.stdout.write(`\r${frame} ${dim(this.spinnerLabel)}…`);
    }, 80);
  }

  stopSpinner(): void {
    if (!this.spinnerTimer) return;
    clearInterval(this.spinnerTimer);
    this.spinnerTimer = undefined;
    process.stdout.write("\r\x1b[K"); // 回车 + 清行
  }
}
