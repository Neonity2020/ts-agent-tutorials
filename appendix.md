# 附录 · 速查手册

## A. 术语表

| 术语 | 一句话解释 | 详见 |
|------|-----------|------|
| Agent | LLM + 工具 + 循环：模型自主决定调用哪些工具、何时结束 | 第 0 章 |
| Tool Calling / Function Calling | 模型输出"请帮我调 X(参数)"的结构化请求，由客户端执行后回填 | 第 2 章 |
| Agent Loop | `while`：请求模型 → 执行工具 → 回填结果 → 重复，直到模型不再要工具 | 第 3 章 |
| JSON Schema | 描述工具参数结构的规范，模型依据它填参 | 第 2 章 |
| Zod | TS 的 schema 校验库；v4 起内置 `z.toJSONSchema()`，一份 schema 喂模型和编译器 | 第 2/4 章 |
| System Prompt | 对话开头给模型的"岗位说明书"，权重最高的指令 | 第 5 章 |
| Token | 模型的计费与窗口单位；中文约 1 字 ≈ 1 token | 第 1 章 |
| Context Window | 一次请求能容纳的最大 token 数；超出即报错 | 第 5 章 |
| Compaction | 把旧历史让模型压成摘要、保留近况的上下文回收手段 | 第 5 章 |
| Prompt Injection | 借工具读到的内容夹带恶意指令，操纵 Agent 行为 | 第 4/8 章 |
| RAG | 检索增强生成：先语义检索相关片段，再交给模型作答 | 第 6 章 |
| Embedding | 把文本映射为向量；余弦相似度衡量语义接近程度 | 第 6 章 |
| Subagent / Spawn | 主 Agent 派生的、拥有独立上下文的子 Agent，只回传最终报告 | 第 7 章 |
| Handoff | 对话控制权在多个 Agent 间的移交（携带完整历史） | 第 7 章 |
| Human-in-the-loop | 关键操作前人工确认（y/N/a）的控制模式 | 第 8 章 |
| Plan-then-Execute | 先（只读工具）产出计划，人工批准后再执行 | 第 8 章 |
| AbortSignal | Web 标准取消机制，贯通模型请求与工具执行 | 第 1/8 章 |
| SSE | Server-Sent Events，流式输出的底层 HTTP 协议 | 第 1/9 章 |
| Eval | 用任务数据集 + 判分函数度量 Agent 能力，防回归 | 第 10 章 |
| LLM-as-judge | 用另一个模型按标准给输出打分 | 第 10 章 |
| Trace | 一次任务的完整事件记录（含模型看到的上下文），可回放排障 | 第 10 章 |
| MCP | Model Context Protocol：Agent 应用与工具源之间的开放标准接口 | 第 11 章 |

## B. 常见坑清单（全教程合集）

**API 与协议层**
- 忘记回填 `role:"tool"` 消息 → 400；`tool_call_id` 配对错位 → 模型张冠李戴
- 流式 SSE 忘了 buffer 按"行"攒 → 偶发 JSON 解析失败；忘了 `{ stream: true }` 解码 → 中文乱码
- 流式拿不到 usage → 先查是不是从 `choices[0].usage` 取的（规范里 usage 在 SSE 数据**顶层**，最后一个 chunk 的 `choices` 是空数组）；再查服务商的 `stream_options` 开关。此坑静默：tokens 统计恒为 0 但不报错
- 401 查 Key、404 查 BASE_URL 路径段、429 上退避重试

**工具设计**
- 工具 description 不写使用场景 → 模型该调不调、不该调乱调
- 工具结果不截断、不分页 → 上下文爆炸的头号来源
- 工具异常直接 throw → 击穿循环；正确做法是错误文本回填让模型自愈
- 字符串拼接执行命令（`exec`）→ 注入风险；用 `execFile` 数组参数 + 白名单

**上下文**
- 爆窗口了才压缩 → 质量早已衰减；阈值 80%
- 压缩把 system prompt 或最近几轮压掉 → 模型断片
- 摘要丢失数字/路径等具体事实 → 摘要 prompt 点名要求保留

**控制与安全**
- 不设 `maxTurns` → 死循环烧钱
- readonly 靠 prompt 自觉 → 不如物理拿走工具
- yolo + 写权限 + 无人值守 → 事故配方，三选一去掉
- 会话恢复直接续跑 → 悬空 tool_calls 400；先追加 user 消息让模型核实

**流程与工程**
- 改 prompt 不跑 eval → 静默回归；eval 是 prompt 的版本管理
- 对 LLM 输出断言字面全文 → 向随机性开战；断言特征与结构
- trace 只记动作不记输入 → 排障时永远差"它当时看到了什么"
- 多 Agent 任务不自包含（"继续刚才的"） → 子 Agent 一脸懵；通信即上下文
- MCP client/transport 用完不 close → 子进程不退、Node 进程挂着；一次性脚本在 `finally` 里 `client.close()` + `transport.close()`

## C. 本教程代码文件索引

| 文件 | 诞生 | 职责 |
|------|------|------|
| `src/lib/llm.ts` | 第 1 章 | chat / chatStreamFull / token 估算 |
| `src/lib/tools.ts` | 第 2/4 章 | defineTool / runToolCall / 沙箱路径 |
| `src/lib/agent.ts` | 第 3 章（12 章定稿） | agentLoop 最终整合版 |
| `src/lib/compact.ts` | 第 5 章 | maybeCompact 历史压缩 |
| `src/lib/memory.ts` / `rag.ts` | 第 6 章 | 文件记忆工具 / embedding 检索 |
| `src/lib/subagent.ts` | 第 7 章 | spawn 工具工厂 / 并发池 |
| `src/lib/approval.ts` / `session.ts` | 第 8 章 | 权限确认 / 会话持久化 |
| `src/lib/ui.ts` / `events.ts` | 第 9 章 | 终端渲染 / 事件协议 |
| `src/lib/trace.ts` | 第 10 章 | JSONL trace |
| `src/lib/mcp.ts` + `src/mcp/*` | 第 11 章 | MCP 桥接 / 示例 server |
| `src/mini-agent.ts` | 第 12 章 | 毕业项目主程序 |
| `evals/` | 第 10 章 | 用例集与 runner |

## D. 延伸阅读

- **Anthropic《Building Effective Agents》**：把 workflow 与 agent 分型讲得最清楚的一篇，与本教程第 0/7 章互为印证
- **OpenAI Cookbook**（Function Calling、Structured Outputs 章节）：协议细节的另一参照系
- **Model Context Protocol 文档**（modelcontextprotocol.io）：协议规范、SDK、社区 server 目录
- **Vercel AI SDK 文档**：学完本教程后值得掌握的生产级框架，你会发现每个抽象都眼熟
- **Zod v4 文档**：`z.toJSONSchema` 与自定义校验的完整能力
- **各家模型定价页**：token 单价、上下文窗口、限流额度以官方为准——这本书里所有具体数字都会过时，机制不会

## E. 检验你是否真的"Hero"了

不看正文，回答这五个问题：

1. 为什么说"Agent 的可靠性一半来自工具报错的质量"？
2. 上下文压缩为什么保留最近 N 条不压？切分配对校验怎么做？
3. `readonly` 权限为什么靠工具集隔离而不是 prompt 嘱咐？
4. 流式工具调用的参数分片按什么拼装？什么时候能开始向用户提示工具名？
5. 你的 Agent 把 `/etc/passwd` 读给了模型，防线应该在几层？分别是什么？

答不上来的章节，回去重读——然后打开第 12 章的 mini-agent，把它变成你自己的。
