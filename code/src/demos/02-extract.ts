// 第 2 章示例：结构化输出——用"提取工具"逼模型按 Zod schema 产出
import { z } from "zod";
import { chat, type ChatMessage } from "../lib/llm";

const Invoice = z.object({
  seller: z.string().describe("开票方名称"),
  amount: z.number().describe("价税合计，数字，不带单位"),
  date: z.string().describe("开票日期，YYYY-MM-DD"),
});
type Invoice = z.infer<typeof Invoice>;

const extractInvoice = {
  type: "function",
  function: {
    name: "record_invoice",
    description: "从文本中提取发票信息后调用此工具登记",
    parameters: z.toJSONSchema(Invoice), // Zod v4 内置 JSON Schema 转换
  },
};

const text = `今收到星辰科技开具的增值税发票一张，金额合计 12,800.00 元（含税），
开票日期 2026 年 8 月 17 日，货物为服务器托管服务。`;

const messages: ChatMessage[] = [{ role: "user", content: `提取发票信息：\n${text}` }];
const { message } = await chat(messages, { tools: [extractInvoice] });

if (message.tool_calls?.length) {
  const args = JSON.parse(message.tool_calls[0].function.arguments);
  const invoice: Invoice = Invoice.parse(args); // Zod 校验：通过则类型可信
  console.log(invoice);
  // { seller: '星辰科技', amount: 12800, date: '2026-08-17' }
} else {
  console.log("模型没有调用提取工具，回答是：", message.content);
}
