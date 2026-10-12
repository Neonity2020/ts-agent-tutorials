# 第 6 章 · 记忆与检索：让 Agent 记住上一次

> 本章新增文件：`src/lib/memory.ts`、`src/lib/rag.ts`、`src/demos/06-memory.ts`

**本章你会学会：**

- 区分四种记忆，分别选型
- 用 markdown 文件实现跨会话长期记忆（并让 Agent 自己维护它）
- 实现 embedding + 余弦相似度的 mini-RAG
- 判断什么时候该 RAG、什么时候不该

## 6.1 四种记忆，一张表选型

| 类型 | 生命周期 | 载体 | 本教程位置 |
|------|----------|------|-----------|
| 工作记忆 | 单轮请求 | messages 数组 | 第 1、5 章 |
| 任务记忆 | 单次任务 | 压缩摘要（compaction） | 第 5 章 |
| 长期记忆（ Few 条核心事实） | 跨会话 | markdown 文件 | 本章 6.2 |
| 知识库（大量文档） | 跨会话、可检索 | 向量/文件 + 检索 | 本章 6.3 |

多数"给 Agent 加记忆"的需求，其实是前三种：**别急着上向量数据库**。第 5 章已经解决了单任务内的问题，本章处理"跨会话"。

## 6.2 长期记忆：一个 markdown 文件就够

最被低估的记忆方案：`memory/MEMORY.md`——人类可读、可 diff、可手改、零依赖。Claude Code 的 `CLAUDE.md`、各家产品的"项目规则"文件都是这个思路。

两个组件：

**组件一：启动时注入。** 会话开始，把记忆文件塞进 system prompt（第 5 章预算表里那 5%）：

```ts
import { readFile } from "node:fs/promises";

export async function loadMemory(path = "memory/MEMORY.md"): Promise<string> {
  try {
    const text = await readFile(path, "utf8");
    return `\n# 已知的项目记忆（此前会话沉淀，可能过时，重要处需核实）\n${text}\n`;
  } catch {
    return ""; // 第一次运行还没有记忆
  }
}

// agentLoop 的 system 后拼接：opts.system + await loadMemory()
```

**组件二：让 Agent 自己写记忆。** 记忆不该靠用户手工维护，加两个工具让 Agent 在工作中沉淀：

```ts
import { mkdir, appendFile, writeFile, readFile } from "node:fs/promises";
import { z } from "zod";
import { defineTool } from "./tools";

const MEMORY_DIR = "memory";

export const rememberTool = defineTool({
  name: "remember",
  description: "把一条值得跨会话记住的事实（用户偏好、项目约定、踩过的坑、关键路径）追加到长期记忆",
  schema: z.object({
    fact: z.string().describe("一句话事实，自包含（不要写'上面提到的'这类指代）"),
    category: z.enum(["preference", "convention", "lesson", "fact"]).describe(
      "preference=用户偏好, convention=项目约定, lesson=踩坑教训, fact=关键事实",
    ),
  }),
  execute: async ({ fact, category }) => {
    await mkdir(MEMORY_DIR, { recursive: true });
    const date = new Date().toISOString().slice(0, 10);
    await appendFile(`${MEMORY_DIR}/MEMORY.md`, `- [${date}][${category}] ${fact}\n`, "utf8");
    return `已记住：${fact}`;
  },
});

export const forgetTool = defineTool({
  name: "update_memory",
  description: "查看当前全部长期记忆；可删除其中某条（用其完整行内容匹配）",
  schema: z.object({
    deleteLine: z.string().optional().describe("要删除的完整行内容；不传则只查看"),
  }),
  execute: async ({ deleteLine }) => {
    await mkdir(MEMORY_DIR, { recursive: true });
    const path = `${MEMORY_DIR}/MEMORY.md`;
    const text = await readFile(path, "utf8").catch(() => "(空)");
    if (!deleteLine) return text;
    const next = text.split("\n").filter((l) => l.trim() && !l.includes(deleteLine)).join("\n") + "\n";
    await writeFile(path, next, "utf8");
    return `已删除。当前记忆：\n${next}`;
  },
});
```

设计动机：

- **`remember` 的 description 教会模型"什么值得记"**（用户偏好、约定、坑、路径）。也可以在 system prompt 里加一条规则："每次会话结束前，若发现值得沉淀的事实，调用 remember"。
- **每条记忆自包含 + 带日期**：三个月后这条记忆会被独立读取，"他说得对"这种指代性记忆毫无价值。
- **记忆是可审计的**：出问题（Agent 坚持一个错误偏好）时直接打开 md 文件看哪条记忆在作怪、删掉即可。这是文件方案优于一切黑盒记忆库的地方。
- **注入时注明"可能过时，需核实"**：记忆是 hint 不是 fact，避免模型把三个月前的路径当真理。

规模边界：这份文件控制在 1~2k tokens（约百条以内）。再大，就该把"每条记忆一行"变成可检索的（下一节），或定期让模型自己整理压缩记忆文件（留作练习）。

## 6.3 Mini-RAG：embedding + 余弦相似度

当知识超出"百条以内"——几百页文档、全部历史笔记——就进入检索范式：**把知识切块、向量化存起来；查询时把问题也向量化，取最相近的几块塞进上下文**。这就是 RAG（Retrieval-Augmented Generation）。

> `src/lib/rag.ts` —— 约百行，无外部向量库依赖

```ts
import { API_KEY, BASE_URL, type ChatMessage } from "./llm";

// ---------- 向量化 ----------
async function embed(texts: string[]): Promise<number[][]> {
  const res = await fetch(`${BASE_URL}/embeddings`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify({ model: process.env.EMBEDDING_MODEL ?? "embedding-3", input: texts }),
  });
  if (!res.ok) throw new Error(`Embedding API ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.data.map((d: { embedding: number[] }) => d.embedding);
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

// ---------- 切块 ----------
export interface Chunk { id: number; source: string; text: string; vector?: number[] }

/** 按段落切块，目标 ~400 字，相邻块重叠 ~50 字（保住被切断的上下文） */
export function chunkText(text: string, source: string, size = 400, overlap = 50): Chunk[] {
  const paras = text.split(/\n\s*\n/).filter((p) => p.trim());
  const chunks: string[] = [];
  let cur = "";
  for (const p of paras) {
    if ((cur + "\n" + p).length > size && cur) {
      chunks.push(cur);
      cur = cur.slice(-overlap) + "\n" + p; // 重叠
    } else {
      cur = cur ? cur + "\n" + p : p;
    }
  }
  if (cur) chunks.push(cur);
  return chunks.map((t, i) => ({ id: i, source, text: t }));
}

// ---------- 索引与检索 ----------
export interface RagIndex { chunks: Chunk[] }

export async function buildIndex(docs: { name: string; content: string }[]): Promise<RagIndex> {
  const chunks = docs.flatMap((d) => chunkText(d.content, d.name));
  // 批量向量化（一次请求多段，省钱省时）
  const vectors = await embed(chunks.map((c) => c.text));
  vectors.forEach((v, i) => (chunks[i].vector = v));
  return { chunks };
}

export async function search(index: RagIndex, query: string, k = 4) {
  const [qv] = await embed([query]);
  return index.chunks
    .map((c) => ({ ...c, score: cosine(qv, c.vector!) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}
```

**把它做成工具**，让 Agent 按需检索（而不是每次全量塞入）：

```ts
import { defineTool } from "./tools";
import { z } from "zod";

let index: RagIndex; // 启动时 buildIndex()

export const searchKnowledge = defineTool({
  name: "search_knowledge",
  description: "在项目知识库中语义检索相关资料片段。回答涉及背景资料的问题前先调用。",
  schema: z.object({
    query: z.string().describe("用完整的陈述句描述要找的内容，而非关键词堆砌"),
  }),
  execute: async ({ query }) => {
    const hits = await search(index, query, 4);
    if (!hits.length) return "ERROR: 知识库为空";
    return hits
      .map((h, i) => `[${i + 1}] (source: ${h.source}, score: ${h.score.toFixed(3)})\n${h.text}`)
      .join("\n---\n");
  },
});
```

跑通后值得手动验证检索质量（给 `search` 写几组 query 看返回）——**RAG 系统八成的失败在检索质量而不是生成质量**。检索不行的常见原因：切块太大（一段块里混多个主题）、query 是关键词堆砌（embedding 对自然语句更敏感）、文档本身质量差。

> 注：`embedding-3` 是智谱的向量模型名；OpenAI 用 `text-embedding-3-small`。与 chat 不同厂时，给 `embed()` 单独配一套 base/key 环境变量。索引持久化只需把 `chunks`（含 vector）`JSON.stringify` 到文件，启动时载入——量小用文件，量大再考虑向量库。

## 6.4 什么时候不用 RAG

RAG 是重方案，先用轻方案排除：

- **知识能装进 1~2k tokens** → 直接整个注入（6.2 的记忆文件）。注入的完整知识永远优于检索的碎片。
- **知识是结构化的、可枚举的**（API 文档、配置项）→ 让模型用 `read_file`/`grep` 类工具直接查，准确率高于语义检索。
- **代码库问答** → 先试 grep 式工具（精确匹配标识符），RAG 只作为语义补充（"哪里处理了退款"这类 grep 不出的查询）。
- **要求逐字精确**（合同、法条）→ 语义检索会"找意思相近的"，恰是你要避免的。

一句话：**grep 解决精确，RAG 解决语义，注入解决小而全。** 三者常组合：先 RAG 缩小范围，再 grep/read 精读。

## 练习

1. 跑通 6.2：让 agent 干几件事、你纠正它几次，看 `MEMORY.md` 里沉淀了什么；第二天开新会话验证它"记得"。
2. 给 6.3 建一个知识库（把你某个项目的 README + 几篇笔记喂进去），测 5 组问答，记录哪组检索失败、为什么（切块？query 写法？）。
3. 实现"记忆整理"工具：让模型把 `MEMORY.md` 里重复、过时、可合并的条目重写成一份更短的文件（这本质是第 5 章的 compaction 用于记忆）。
4. 挑战：给 `search` 加"混合检索"——余弦相似度得分与简单关键词命中率（如 grep 计数）加权融合。对比纯向量的效果差异。

## 常见坑

- **一切记忆问题都上向量库**：90% 的场景 6.2 的 md 文件方案就够，先解决"记什么"再解决"怎么存"。
- **记忆写入无节制**：模型把每次对话流水账都 remember，两周后记忆文件比代码还长。description 里写清"值得跨会话记住的"，并配整理机制（练习 3）。
- **检索结果不带 source/score 就塞给模型**：模型无法判断可信度，也无法在答案里引用出处。永远带元数据。
- **切块按固定字符数硬切**：代码被从函数中间切断、表格被腰斩。按结构切（段落/函数/章节），重叠兜底。
- **忘记 embedding 与 chat 模型维度无关也无兼容问题，但费用照烧**：索引是离线一次性成本，别在每次请求时重建索引。

---

上一章：[第 5 章](05-context-engineering.md) · 下一章：[第 7 章 · 多 Agent 协作](07-multi-agent.md)
