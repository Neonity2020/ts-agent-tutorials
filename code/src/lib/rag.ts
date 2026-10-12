// 第 6 章 · mini-RAG：embedding + 余弦相似度（无向量库依赖）
// 用法见第 6 章教程：buildIndex 一次离线建索引，search 按需检索；
// 库文件不设 demo，避免每次运行都烧 embedding 费用。
import { API_KEY, BASE_URL, EMBEDDING_MODEL } from "./llm";

async function embed(texts: string[]): Promise<number[][]> {
  const res = await fetch(`${BASE_URL}/embeddings`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify({ model: EMBEDDING_MODEL, input: texts }),
  });
  if (!res.ok) throw new Error(`Embedding API ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.data.map((d: { embedding: number[] }) => d.embedding);
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

export interface Chunk {
  id: number;
  source: string;
  text: string;
  vector?: number[];
}

/** 按段落切块，目标 ~size 字，相邻块重叠 overlap 字（保住被切断的上下文） */
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

export interface RagIndex {
  chunks: Chunk[];
}

export async function buildIndex(docs: { name: string; content: string }[]): Promise<RagIndex> {
  const chunks = docs.flatMap((d) => chunkText(d.content, d.name));
  const vectors = await embed(chunks.map((c) => c.text)); // 批量向量化
  vectors.forEach((v, i) => (chunks[i].vector = v));
  return { chunks };
}

export async function search(index: RagIndex, query: string, k = 4) {
  const [qv] = await embed([query]);
  if (!qv) return [];
  return index.chunks
    .map((c) => ({ ...c, score: cosine(qv, c.vector ?? []) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}
