/**
 * The keywords the Trailblazer picks Flow's topics from (ADR 0084 §4,
 * amendment "topics are picked"). A list, not a text box: the owner found the
 * issues "too technical" when they were read off the workspaces' libraries,
 * and asked for a set of keywords to choose from. The groups follow Google
 * News's own sections (technology, science, entertainment, business), with
 * games and anime beside them for the people this app is for.
 *
 * Plain data, no Node: the renderer's picker reads it through the package's
 * `flow-topics` export, and the pipeline names the picked ones in the issue's
 * language.
 */

export interface FlowTopic {
  readonly id: string;
  readonly zh: string;
  readonly en: string;
}

export interface FlowTopicGroup {
  readonly id: string;
  readonly zh: string;
  readonly en: string;
  readonly topics: readonly FlowTopic[];
}

export const FLOW_TOPIC_GROUPS: readonly FlowTopicGroup[] = [
  {
    id: "tech",
    zh: "科技",
    en: "Tech",
    topics: [
      { id: "ai", zh: "人工智能", en: "AI" },
      { id: "gadgets", zh: "数码产品", en: "Gadgets" },
      { id: "open-source", zh: "开源", en: "Open source" },
      { id: "security", zh: "网络安全", en: "Cybersecurity" },
    ],
  },
  {
    id: "science",
    zh: "科学",
    en: "Science",
    topics: [
      { id: "space", zh: "航天与天文", en: "Space" },
      { id: "physics", zh: "物理", en: "Physics" },
      { id: "math", zh: "数学", en: "Mathematics" },
      { id: "biology", zh: "生物", en: "Biology" },
      { id: "health", zh: "医学与健康", en: "Health & medicine" },
      { id: "climate", zh: "气候与环境", en: "Climate" },
    ],
  },
  {
    id: "games",
    zh: "游戏与动漫",
    en: "Games & anime",
    topics: [
      { id: "games", zh: "电子游戏", en: "Video games" },
      { id: "indie-games", zh: "独立游戏", en: "Indie games" },
      { id: "anime", zh: "动画", en: "Anime" },
      { id: "manga", zh: "漫画", en: "Manga" },
    ],
  },
  {
    id: "culture",
    zh: "文化",
    en: "Culture",
    topics: [
      { id: "movies", zh: "电影", en: "Movies" },
      { id: "series", zh: "剧集", en: "TV series" },
      { id: "music", zh: "音乐", en: "Music" },
      { id: "books", zh: "书籍", en: "Books" },
      { id: "design", zh: "设计", en: "Design" },
    ],
  },
  {
    id: "business",
    zh: "商业",
    en: "Business",
    topics: [
      { id: "startups", zh: "创业公司", en: "Startups" },
      { id: "big-tech", zh: "科技公司", en: "Big Tech" },
    ],
  },
];

/** Picked when Flow is first turned on: broad, and not all of them code. */
export const DEFAULT_FLOW_TOPICS: readonly string[] = [
  "ai",
  "gadgets",
  "space",
  "games",
  "movies",
];

/** Topics read at most: eight queries cannot cover more. */
export const MAX_FLOW_TOPICS = 12;

const BY_ID: ReadonlyMap<string, FlowTopic> = new Map(
  FLOW_TOPIC_GROUPS.flatMap((g) => g.topics.map((t) => [t.id, t] as const)),
);

/** The known ids among `raw`, once each, in order, at most twelve. */
export function knownFlowTopics(raw: readonly unknown[]): string[] {
  const out: string[] = [];
  for (const id of raw) {
    if (typeof id !== "string" || !BY_ID.has(id) || out.includes(id)) continue;
    out.push(id);
    if (out.length >= MAX_FLOW_TOPICS) break;
  }
  return out;
}

/** The picked topics as the issue's language names them. */
export function flowTopicNames(
  ids: readonly string[],
  lang: "zh" | "en",
): string[] {
  return knownFlowTopics(ids).map((id) => (BY_ID.get(id) as FlowTopic)[lang]);
}
