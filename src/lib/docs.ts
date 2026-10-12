import { getCollection, type CollectionEntry } from "astro:content";

export type Doc = CollectionEntry<"docs">;

/** 文件名形如 `04-tool-system.md` / `appendix.md` */
export interface DocMeta {
  title: string;
  /** 去掉 `第 N 章 · ` 前缀的短标题，用于侧边栏/列表 */
  short: string;
  chapter: string;
  order: number;
  appendix: boolean;
  files: string[];
}

/** 从正文里抽信息：首个 H1 作标题，首个引用块里的 `文件` 作本章改动清单 */
export function parseDoc(id: string, body: string): DocMeta {
  const title = body.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? id;

  // `> 本章新增文件：a.ts、b.ts` / `> 本章修改文件：x.ts（说明）`
  const files: string[] = [];
  for (const m of body.matchAll(/^>\s*本章(?:新增|修改)文件[:：]\s*(.+)$/gm)) {
    for (const raw of m[1].split(/[、,，]/)) {
      const f = raw.match(/`([^`]+)`/)?.[1] ?? raw.replace(/（.*?）|\(.*?\)/g, "").trim();
      if (f) files.push(f);
    }
  }

  const appendix = id === "appendix";
  const num = Number(id.slice(0, 2));

  return {
    title,
    short: shortTitle(title),
    chapter: appendix ? "附录" : `第 ${num} 章`,
    order: appendix ? 99 : num,
    appendix,
    files,
  };
}

/** URL slug：00-introduction → 00-introduction */
export const slugOf = (id: string) => id.replace(/\.md$/, "");

/**
 * 站内链接一律带尾斜杠。
 * 托管端对 `/04-tool-system` 会回退到首页（而不是 301 到 `/04-tool-system/`），
 * 所以尾斜杠必须由我们自己写进 href，不能指望托管端或 Astro 自动补。
 */
export const urlOf = (slug: string) => `/${slug}/`;

/** 取出「本章主题」的短标题，用于列表显示：去掉 `第 N 章 · ` 前缀 */
export function shortTitle(title: string): string {
  return title.replace(/^第\s*\d+\s*章\s*[·:：]?\s*/, "").replace(/^附录\s*[·:：]?\s*/, "");
}

/** 全部文档，按章节顺序排好，附带解析后的元信息 */
export async function getAllDocs(): Promise<DocWithMeta[]> {
  const entries = await getCollection("docs", ({ id }) => id !== "README");
  const docs = entries.map((entry) => {
    const meta = parseDoc(entry.id, entry.body ?? "");
    return { ...entry, meta, slug: slugOf(entry.id) };
  });
  return docs.sort((a, b) => a.meta.order - b.meta.order || a.id.localeCompare(b.id));
}

/** 一篇文档 + 解析出的元信息 + URL slug */
export type DocWithMeta = Doc & { meta: DocMeta; slug: string };

/** 首页/侧边栏用的精简卡片数据 */
export interface ChapterCard {
  slug: string;
  title: string;
  short: string;
  chapter: string;
  order: number;
}

/** 首页章节总表（不含附录） */
export const chapterCards = (docs: Awaited<ReturnType<typeof getAllDocs>>): ChapterCard[] =>
  docs.map((d) => ({
    slug: d.slug,
    title: d.meta.title,
    short: shortTitle(d.meta.title),
    chapter: d.meta.chapter,
    order: d.meta.order,
  }));

/** 快速路线：README 里推荐的跳读顺序 */
export const QUICK_PATH = [0, 1, 2, 3, 4, 12];