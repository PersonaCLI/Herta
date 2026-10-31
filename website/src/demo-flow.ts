/**
 * Flow in the website demo (ADR 0084): the same bridge calls the desktop's
 * main answers, answered from a staged issue so the REAL panel, its radio
 * and its motion play untouched.
 *
 * The issue is written for the demo, not gathered: plausible posts on the
 * default topics from made-up outlets on reserved `.example` hosts, so no
 * one's headline or photo is on the site. Today's pictures were generated
 * for these posts and compressed to small WebP; yesterday's two posts have
 * none and show the panel's own cover.
 *
 * On load the demo gathers once — the radio pulses through the stages —
 * then today's issue lands unread, as a morning's would. Settings is frozen
 * in the demo, so Refresh now and the switch are answered but unreachable.
 */

import type { HertaBridge } from "@gui/ipc/bridge-types";
import { DEFAULT_FLOW_TOPICS } from "@herta/app-server/flow-topics";
import aiModel from "./assets/flow-ai-model.webp";
import filmMiniature from "./assets/flow-film-miniature.webp";
import gadgetHinge from "./assets/flow-gadget-hinge.webp";
import gameLighthouse from "./assets/flow-game-lighthouse.webp";
import spaceLander from "./assets/flow-space-lander.webp";
import type { DemoLang } from "./demo-bridge.js";

// The panel's shapes, read off the bridge contract: `@gui` reaches the
// renderer only, and these live in the gui package's `shared/`.
type Flow = Required<HertaBridge>;
type FlowStateView = Awaited<ReturnType<Flow["flowState"]>>;
type FlowIssueView = Awaited<ReturnType<Flow["flowIssues"]>>[number];
type FlowPostView = FlowIssueView["posts"][number];
type FlowSettingsView = Awaited<ReturnType<Flow["flowSettings"]>>;
type FlowEvent = Parameters<Parameters<Flow["onFlow"]>[0]>[0];

type DemoFlow = Required<
  Pick<
    HertaBridge,
    | "flowState"
    | "flowIssues"
    | "flowRefresh"
    | "flowMarkRead"
    | "flowOpenSource"
    | "flowSettings"
    | "flowSetSettings"
    | "onFlow"
  >
>;

/** A post as written here: the panel's fields, minus what the day sets. */
type Staged = Omit<FlowPostView, "id" | "date">;

/** `YYYY-MM-DD`, local: the panel groups and labels posts by the local day. */
function localDate(daysAgo: number): string {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

const ZH_TODAY: readonly Staged[] = [
  {
    url: "https://orbitalweekly.example/lander-hover-hop",
    site: "轨道周刊",
    title: "可复用月面着陆器完成首次悬停跳跃试验",
    summary:
      "一台缩比着陆器在沙漠试验场升至约 3 米高度，悬停 12 秒后横移 5 米落回，为明年的月面着陆演示收集发动机节流与着陆腿缓冲数据。",
    why: "你关注航天与天文",
    detail: `一台缩比的可复用月面着陆器于本周在沙漠试验场完成首次悬停跳跃。着陆器升至约 3 米高度，悬停 12 秒，随后横移 5 米，落回指定区域。

### 试验目的

此次试验主要验证两项技术：发动机的深度节流，以及着陆腿在硬着陆时的缓冲能力。月面着陆需要在接近地面时把推力降得很低，同时保持姿态稳定。

### 关键数据

| 项目 | 数值 |
|---|---|
| 最大高度 | 约 3 米 |
| 悬停时间 | 12 秒 |
| 横移距离 | 5 米 |
| 推力范围 | 40%–100% |

### 后续计划

团队计划在数月内进行 30 米高度的完整下降剖面试验，并据此完善明年月面演示任务的着陆软件。`,
    points: [
      "悬停 12 秒，横移 5 米后落回指定区域",
      "发动机在 40%–100% 推力之间平稳节流",
      "下一步是 30 米高度的完整下降剖面",
    ],
    word: "悬停十二秒也算跳跃？行吧，第一次总得有人鼓掌。等它跳到三十米再叫我。",
    picture: spaceLander,
  },
  {
    url: "https://modelnotes.example/8b-multilingual",
    site: "模型札记",
    title: "开源社区发布 8B 多语言模型，长文本检索更稳",
    summary:
      "新模型支持 128K 上下文，在多语言长文本检索评测中较上一代提高约 6 个百分点；权重以宽松许可发布，量化版本可在单张消费级显卡上运行。",
    why: "你关注人工智能",
    detail: `一个开源社区发布了参数量约 8B 的多语言模型。新模型支持 128K 上下文，覆盖 20 余种语言，权重以宽松许可发布。

### 评测结果

| 评测 | 上一代 | 新模型 |
|---|---|---|
| 长文本检索 | 71.2 | 77.4 |
| 多语言问答 | 64.8 | 66.1 |
| 代码补全 | 52.3 | 53.0 |

提升主要集中在长文本检索，其余两项变化不大。

### 使用方式

4 位量化版本可在 16 GB 显存的消费级显卡上运行。社区同时公开了训练数据的构成说明，但未公开全部数据。`,
    points: [
      "上下文长度 128K，覆盖 20 余种语言",
      "长文本检索评测提高约 6 个百分点",
      "4 位量化版本可在 16 GB 显存上运行",
    ],
    word: "提高六个点。先看评测集是不是他们自己出的，是的话，就当没提高。",
    picture: aiModel,
  },
  {
    url: "https://teardownlab.example/fold-hinge-200k",
    site: "拆解实验室",
    title: "折叠屏平板铰链耐久测试：二十万次之后",
    summary:
      "实验室用机械臂将一台折叠屏平板反复开合二十万次，铰链仍能在任意角度悬停，屏幕折痕深度增加约 0.1 毫米，未出现显示异常。",
    why: "你关注数码硬件",
    detail: `实验室用一台机械臂，将一款折叠屏平板反复开合二十万次，以检验铰链与屏幕的耐久性。

### 测试方法

测试在 25°C、50% 湿度的环境下进行，每次开合角度为 0° 至 180°，每完成五万次记录一次铰链阻尼与折痕深度。

### 结果

二十万次后，铰链仍能在任意角度悬停，阻尼基本不变；屏幕折痕深度增加约 0.1 毫米，显示与触控均无异常。

### 结论

按每天开合一百次计算，二十万次约相当于五年的使用。`,
    points: [
      "开合二十万次后铰链阻尼基本不变",
      "折痕深度增加约 0.1 毫米",
      "测试在 25°C、50% 湿度下进行",
    ],
    word: "二十万次还能悬停，比大多数人的新年计划耐用。",
    picture: gadgetHinge,
  },
  {
    url: "https://indieweekly.example/lighthouse-keeper",
    site: "独立游戏周报",
    title: "独立游戏《灯塔守夜人》登顶周榜，全程只用一个按键",
    summary:
      "这款由两人团队开发的解谜游戏只需一个按键：按下点亮灯塔，松开熄灭。发售首周好评率 96%，销量超过十万份。",
    why: "你关注独立游戏",
    detail: `《灯塔守夜人》是一款由两人团队历时三年开发的解谜游戏，发售首周登上平台周榜首位。

### 玩法

全程只用一个按键：按下点亮灯塔，松开熄灭。船只在雾中靠近，玩家需要判断何时照亮航道、何时熄灯避开礁石上的危险。

### 反响

发售首周销量超过十万份，好评率 96%。评测普遍认为它的难度曲线平稳，后期关卡对时机的要求很高。`,
    points: ["两人团队开发，历时三年", "发售首周销量超过十万份", "好评率 96%"],
    word: "一个按键就够了。复杂从来不等于深度，很多人花了十年才明白。",
    picture: gameLighthouse,
  },
  {
    url: "https://framerate.example/scifi-shorts-shortlist",
    site: "帧率",
    title: "科幻短片节公布入围名单，三部作品以实拍模型取代 CG",
    summary:
      "今年入围的十二部短片中，有三部用缩比模型和实拍灯光完成飞船镜头；评审认为实拍光影在大银幕上更有质感。",
    why: "你关注电影",
    detail: `一个科幻短片节公布了今年的入围名单，共十二部作品。

### 实拍模型

其中三部作品的飞船镜头没有使用 CG，而是以缩比模型配合实拍灯光完成。最大的飞船模型长约 1.8 米，拍摄用时两周。

### 评审意见

评审认为，实拍模型的光影与质感在大银幕上更可信，也让小成本作品在视觉上有了辨识度。颁奖典礼将于下月举行。`,
    points: [
      "十二部短片入围，三部采用实拍模型",
      "最大的飞船模型长约 1.8 米",
      "颁奖典礼下月举行",
    ],
    word: "模型上的光是真的。算出来的光再像，也是算出来的。",
    picture: filmMiniature,
  },
];

const ZH_YESTERDAY: readonly Staged[] = [
  {
    url: "https://astrobulletin.example/andromeda-nova",
    site: "天文通讯",
    title: "业余天文学家在仙女座方向发现一颗新星",
    summary:
      "两名业余观测者在同一晚独立拍到这颗新星，亮度约 15 等，随后经光谱确认为经典新星爆发。",
    why: "你关注航天与天文",
    detail: `两名业余天文观测者在同一晚、于不同地点独立拍到仙女座方向的一颗新星，亮度约 15 等。

### 确认

专业天文台随后进行了光谱观测，确认这是一次经典新星爆发：白矮星表面积累的物质发生热核反应，亮度在数天内大幅上升。`,
    points: ["两名观测者独立发现", "亮度约 15 等", "经光谱确认为经典新星"],
    word: "业余的拍到，专业的确认。分工合理，我没意见。",
    picture: null,
  },
  {
    url: "https://modelnotes.example/reasoning-set",
    site: "模型札记",
    title: "研究团队公开小模型推理能力评测数据集",
    summary:
      "数据集包含 3000 道多步推理题，每道题都附有人工核对的解题过程，以宽松许可发布。",
    why: "你关注人工智能",
    detail: `一个研究团队公开了一套用于评测小模型推理能力的数据集。

### 内容

数据集包含 3000 道多步推理题，涵盖数学、逻辑与常识推理，每道题都附有人工核对的解题过程，便于逐步检查模型的推理是否成立，而不只是比对最终答案。`,
    points: ["3000 道多步推理题", "解题过程均经人工核对", "以宽松许可发布"],
    word: "三千道题都核对了过程，这才叫评测。比一个总分有用得多。",
    picture: null,
  },
];

const EN_TODAY: readonly Staged[] = [
  {
    url: "https://orbitalweekly.example/lander-hover-hop",
    site: "Orbital Weekly",
    title: "Reusable lunar lander completes its first hover hop",
    summary:
      "A subscale lander rose to about 3 metres at a desert test site, hovered for 12 seconds and moved 5 metres sideways before landing, gathering throttle and landing-leg data for next year's lunar demonstration.",
    why: "You follow space",
    detail: `A subscale reusable lunar lander completed its first hover hop at a desert test site this week. It rose to about 3 metres, hovered for 12 seconds, then moved 5 metres sideways and landed inside the target zone.

### Why the test

The hop checks two things: deep throttling of the engine, and how the landing legs absorb a hard touchdown. Landing on the Moon means cutting thrust very low near the surface while holding the vehicle steady.

### The numbers

| Item | Value |
|---|---|
| Peak height | about 3 m |
| Hover time | 12 s |
| Sideways move | 5 m |
| Thrust range | 40%–100% |

### What comes next

The team plans a full descent profile from 30 metres within months, and will tune the landing software for next year's lunar demonstration from it.`,
    points: [
      "Hovered for 12 seconds and landed 5 metres away, inside the target zone",
      "The engine throttled smoothly between 40% and 100% thrust",
      "Next: a full descent profile from 30 metres",
    ],
    word: "Twelve seconds of hovering, and they call it a hop. Fine — someone has to clap the first time. Wake me when it does thirty metres.",
    picture: spaceLander,
  },
  {
    url: "https://modelnotes.example/8b-multilingual",
    site: "Model Notes",
    title:
      "Open community releases an 8B multilingual model with steadier long-context retrieval",
    summary:
      "The new model handles 128K tokens of context and scores about 6 points higher than its predecessor on multilingual long-context retrieval; the weights are under a permissive licence, and a quantized build runs on one consumer GPU.",
    why: "You follow AI",
    detail: `An open community has released a multilingual model of about 8B parameters. It handles 128K tokens of context and more than 20 languages, and its weights are under a permissive licence.

### Results

| Benchmark | Previous | New |
|---|---|---|
| Long-context retrieval | 71.2 | 77.4 |
| Multilingual QA | 64.8 | 66.1 |
| Code completion | 52.3 | 53.0 |

The gain is mostly in long-context retrieval; the other two barely move.

### Running it

A 4-bit quantized build runs on a consumer GPU with 16 GB of memory. The community describes what the training data is made of, but has not released all of it.`,
    points: [
      "128K context, more than 20 languages",
      "About 6 points higher on long-context retrieval",
      "A 4-bit build runs in 16 GB of GPU memory",
    ],
    word: "Six points better. First check whether they wrote the benchmark themselves — if they did, call it zero.",
    picture: aiModel,
  },
  {
    url: "https://teardownlab.example/fold-hinge-200k",
    site: "Teardown Lab",
    title: "A foldable tablet's hinge after 200,000 folds",
    summary:
      "A lab had a robot arm open and close a foldable tablet 200,000 times. The hinge still holds at any angle, the crease is about 0.1 mm deeper, and the display shows no faults.",
    why: "You follow gadgets",
    detail: `A lab used a robot arm to open and close a foldable tablet 200,000 times, to test how the hinge and the screen hold up.

### Method

The test ran at 25°C and 50% humidity, opening from 0° to 180° each time, with the hinge's resistance and the crease depth measured every 50,000 folds.

### Results

After 200,000 folds the hinge still holds at any angle, with its resistance almost unchanged. The crease is about 0.1 mm deeper, and the display and touch work normally.

### In practice

At a hundred folds a day, 200,000 folds is about five years of use.`,
    points: [
      "Hinge resistance almost unchanged after 200,000 folds",
      "The crease is about 0.1 mm deeper",
      "Tested at 25°C and 50% humidity",
    ],
    word: "Two hundred thousand folds and it still holds its angle. More durable than most New Year's resolutions.",
    picture: gadgetHinge,
  },
  {
    url: "https://indieweekly.example/lighthouse-keeper",
    site: "Indie Weekly",
    title: "One-button puzzle game Lighthouse Keeper tops the weekly chart",
    summary:
      "Made by a two-person team, the puzzle game is played with a single button: hold to light the lamp, release to darken it. In its first week it sold over 100,000 copies with 96% positive reviews.",
    why: "You follow indie games",
    detail: `Lighthouse Keeper, a puzzle game made by a two-person team over three years, reached the top of the platform's weekly chart in its first week.

### How it plays

The whole game uses one button: hold to light the lamp, release to darken it. Ships approach through the fog, and the player decides when to light the channel and when to go dark to keep them off the rocks.

### Reception

It sold over 100,000 copies in its first week, with 96% positive reviews. Reviewers praise a gentle difficulty curve and late levels that demand precise timing.`,
    points: [
      "A two-person team, three years in the making",
      "Over 100,000 copies in the first week",
      "96% positive reviews",
    ],
    word: "One button is enough. Complexity was never depth — some people take ten years to learn that.",
    picture: gameLighthouse,
  },
  {
    url: "https://framerate.example/scifi-shorts-shortlist",
    site: "Frame Rate",
    title:
      "Sci-fi short film festival names its shortlist; three entries use practical models instead of CG",
    summary:
      "Of this year's twelve shortlisted films, three shot their spaceship scenes with scale models under practical lights; the jury found the real light more convincing on a big screen.",
    why: "You follow film",
    detail: `A science-fiction short film festival has named this year's shortlist of twelve films.

### Practical models

Three of the films shot their spaceship scenes without CG, using scale models under practical lights. The largest model is about 1.8 metres long and took two weeks to film.

### The jury

The jury found the light and texture of practical models more convincing on a big screen, and said they give small-budget films a look of their own. The awards ceremony is next month.`,
    points: [
      "Twelve films shortlisted, three with practical models",
      "The largest spaceship model is about 1.8 metres long",
      "Awards ceremony next month",
    ],
    word: "The light on a model is real. Computed light, however close, is still computed.",
    picture: filmMiniature,
  },
];

const EN_YESTERDAY: readonly Staged[] = [
  {
    url: "https://astrobulletin.example/andromeda-nova",
    site: "Astro Bulletin",
    title: "Amateur astronomers find a nova toward Andromeda",
    summary:
      "Two amateur observers caught the nova independently on the same night at about magnitude 15; spectra later confirmed a classical nova outburst.",
    why: "You follow space",
    detail: `Two amateur observers, at different sites on the same night, independently photographed a nova toward Andromeda at about magnitude 15.

### Confirmation

A professional observatory then took spectra and confirmed a classical nova: material gathered on a white dwarf's surface ignited, and its brightness rose sharply over a few days.`,
    points: [
      "Found independently by two observers",
      "About magnitude 15",
      "Confirmed as a classical nova by spectra",
    ],
    word: "Amateurs found it, professionals confirmed it. A sensible division of labour; I have no complaints.",
    picture: null,
  },
  {
    url: "https://modelnotes.example/reasoning-set",
    site: "Model Notes",
    title: "Researchers release a reasoning benchmark for small models",
    summary:
      "The dataset holds 3,000 multi-step reasoning problems, each with a human-checked worked solution, under a permissive licence.",
    why: "You follow AI",
    detail: `A research team has released a dataset for testing how well small models reason.

### What is in it

It holds 3,000 multi-step problems across maths, logic and common-sense reasoning. Every problem has a human-checked worked solution, so a model's reasoning can be checked step by step, not just its final answer.`,
    points: [
      "3,000 multi-step reasoning problems",
      "Every worked solution checked by hand",
      "Under a permissive licence",
    ],
    word: "Three thousand problems with checked working. That is a benchmark — far more use than one total score.",
    picture: null,
  },
];

function issueOf(
  lang: DemoLang,
  daysAgo: number,
  number: number,
  posts: readonly Staged[],
): FlowIssueView {
  const day = localDate(daysAgo);
  const id = `${day}-1`;
  return {
    id,
    number,
    localDate: day,
    lang,
    posts: posts.map((p, n) => ({ ...p, id: `${id}/${n}`, date: day })),
    evidence: { queries: [], hits: [], pages: [] },
  };
}

/** The gathering the demo plays: each stage's state, and when it starts. */
const STEPS: readonly (readonly [number, FlowStateView["gathering"]])[] = [
  [0, { stage: "queries" }],
  [1400, { stage: "search" }],
  [3000, { stage: "cards" }],
  ...[1, 2, 3, 4, 5].map(
    (i) => [4400 + (i - 1) * 600, { stage: "detail", i, n: 5 }] as const,
  ),
  ...[1, 2, 3, 4, 5].map(
    (i) => [7400 + (i - 1) * 500, { stage: "word", i, n: 5 }] as const,
  ),
];
const LANDS_AT_MS = 10400;

export function createDemoFlow(lang: DemoLang): DemoFlow {
  const today = issueOf(lang, 0, 12, lang === "en" ? EN_TODAY : ZH_TODAY);
  const yesterday = issueOf(
    lang,
    1,
    11,
    lang === "en" ? EN_YESTERDAY : ZH_YESTERDAY,
  );
  let issues: FlowIssueView[] = [yesterday];
  let settings: FlowSettingsView = {
    enabled: true,
    topics: DEFAULT_FLOW_TOPICS,
  };
  let state: FlowStateView = {
    enabled: true,
    gathering: null,
    failed: null,
    unreadIssueId: null,
    refreshesLeft: 3,
  };
  const listeners = new Set<(e: FlowEvent) => void>();
  const emit = (e: FlowEvent): void => {
    for (const l of listeners) l(e);
  };
  const setState = (next: FlowStateView): void => {
    state = next;
    emit({ kind: "state", state });
  };

  let timers: ReturnType<typeof setTimeout>[] = [];
  const gather = (): void => {
    for (const t of timers) clearTimeout(t);
    timers = STEPS.map(([at, gathering]) =>
      setTimeout(() => setState({ ...state, gathering }), at),
    );
    timers.push(
      setTimeout(() => {
        issues = [today, yesterday];
        emit({ kind: "issue", issue: today });
        setState({ ...state, gathering: null, unreadIssueId: today.id });
      }, LANDS_AT_MS),
    );
  };
  // The first gathering starts with the app, as a morning's tick would.
  state = { ...state, gathering: { stage: "queries" } };
  gather();

  return {
    flowState: async () => state,
    flowIssues: async () => issues,
    flowRefresh: async () => {
      if (!settings.enabled) return "off";
      if (state.gathering !== null) return "running";
      if (state.refreshesLeft === 0) return "limit";
      setState({ ...state, refreshesLeft: state.refreshesLeft - 1 });
      gather();
      return "started";
    },
    flowMarkRead: (issueId) => {
      if (state.unreadIssueId === issueId)
        setState({ ...state, unreadIssueId: null });
    },
    // The sources are made up: the demo freezes 查看原文 (freeze-chrome.ts).
    flowOpenSource: () => {},
    flowSettings: async () => settings,
    flowSetSettings: async (next) => {
      settings = next;
      setState({ ...state, enabled: next.enabled });
      return settings;
    },
    onFlow: (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
}
