import { useEffect, useRef, useState } from "react";
// WebP, not the .png twins beside them: these are UI screenshots, and a
// 256-colour palette PNG spends its ramp on the dark chrome and drops the
// blue @板砖 chip to grey (measured 2026-08-03). WebP q92 keeps the accent
// and the CJK text at a quarter of the bytes. The .png originals stay on
// disk unbundled — the public README links demo-poster.png as its hero.
import demoPoster from "./assets/demo-poster.webp";
import demoPosterDark from "./assets/demo-poster-dark.webp";
import demoPosterEn from "./assets/demo-poster-en.webp";
import demoPosterEnDark from "./assets/demo-poster-en-dark.webp";
import dreamCycleSvg from "./assets/dream-cycle.svg";
import dreamCycleSvgEn from "./assets/dream-cycle-en.svg";
import hertaIcon from "./assets/herta-icon.png";
import turnFlowSvg from "./assets/turn-flow.svg";
import turnFlowSvgEn from "./assets/turn-flow-en.svg";
import visionSvg from "./assets/vision-autobiography.svg";
import visionSvgEn from "./assets/vision-autobiography-en.svg";

const REPO_URL = "https://github.com/PersonaCLI/Herta";
const DOWNLOAD_URL = `${REPO_URL}/releases`;
/** Chinese-side mirror of the installers (owner 2026-08-07). Only the zh card
 *  offers it: Baidu Pan wants an account and is slow from outside China, so
 *  for EN visitors GitHub Releases stays the better link. The `?pwd=` form
 *  carries the extraction code, and owner-verified that Baidu fills it in — so
 *  the code is NOT printed on the page; it would be a line of noise restating
 *  something the link already does. */
const PAN_URL = "https://pan.baidu.com/s/1k-47zy6TTDWl0OaT2WCFUg?pwd=y195";

/* Inline stroke icons — `currentColor` so they inherit the button's text
 * color, and never fall back to a color-emoji glyph (which is what ☀/☾/⬇
 * rendered as on mobile). `aria-hidden`: the buttons carry their own text
 * or aria-label. */
function DownloadIcon(): JSX.Element {
  return (
    <svg
      className="btn-icon"
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 3v12" />
      <path d="m7 11 5 5 5-5" />
      <path d="M5 20h14" />
    </svg>
  );
}

function SunIcon(): JSX.Element {
  return (
    <svg
      className="btn-icon"
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </svg>
  );
}

function MoonIcon(): JSX.Element {
  return (
    <svg
      className="btn-icon"
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5Z" />
    </svg>
  );
}

/** The app's designed viewport (BrowserWindow min size). The iframe renders
 *  at exactly this and is scaled to the page column, so the renderer never
 *  sees a window smaller than the desktop app allows. */
const DEMO_W = 1440;
const DEMO_H = 900;

/** Below this width the scaled-down live renderer is unusable (≈0.27× on a
 *  phone: sliver-sized tap targets) — narrow screens get a static poster
 *  and never mount the iframe, so they don't download the renderer at all. */
const POSTER_QUERY = "(max-width: 820px)";

function DemoFrame(props: {
  readonly posterNote: string;
  readonly lang: "zh" | "en";
  readonly theme: Theme;
}): JSX.Element {
  const [narrow, setNarrow] = useState(
    () => window.matchMedia(POSTER_QUERY).matches,
  );
  useEffect(() => {
    const mq = window.matchMedia(POSTER_QUERY);
    const onChange = () => setNarrow(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  useEffect(() => {
    if (narrow) return;
    const el = wrapRef.current;
    if (el === null) return;
    const fit = () => setScale(Math.min(1, el.clientWidth / DEMO_W));
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    fit();
    return () => ro.disconnect();
  }, [narrow]);
  if (narrow) {
    // The poster follows the site language AND theme, like the live demo:
    // four captures keyed on lang × theme (the EN ones show @Brick + English
    // chrome; the dark ones show the app's night mode).
    const poster =
      props.lang === "en"
        ? props.theme === "dark"
          ? demoPosterEnDark
          : demoPosterEn
        : props.theme === "dark"
          ? demoPosterDark
          : demoPoster;
    return (
      <figure className="demo-poster">
        <img src={poster} alt="Herta desktop app" loading="lazy" />
        <figcaption>{props.posterNote}</figcaption>
      </figure>
    );
  }
  return (
    <div
      className="demo-fit"
      ref={wrapRef}
      style={{ height: Math.round(DEMO_H * scale) }}
    >
      <iframe
        className="demo-iframe"
        // The ?v build stamp cache-busts demo.html per deploy: HTML is
        // cached ~10 min on Pages, and a stale demo.html resolved OLD
        // (disk-cached, immutable) chunks — the previous demo rendered
        // beside a fresh landing page (seen live 2026-07-12). A fresh
        // landing bundle carries a fresh stamp, so its iframe URL misses
        // the cache and both always come from the same deploy.
        // ?lang= / ?theme= re-mount the demo in the visitor's language and
        // theme (the key change reloads the iframe, re-booting the scripted
        // bridge — the demo bridge pins the app's theme controller to the
        // SITE's effective theme, else it would follow the OS independently
        // and drift from a manual site toggle).
        key={`${props.lang}-${props.theme}`}
        src={`${import.meta.env.BASE_URL}demo.html?v=${__BUILD_ID__}&lang=${props.lang}&theme=${props.theme}`}
        title="Herta — live demo · 可交互演示"
        style={{ transform: `scale(${scale})` }}
      />
    </div>
  );
}

/** Scroll-reveal: elements with .reveal slide in once, when 15% visible.
 *  Reduced-motion visitors get everything immediately. */
function useReveal(dep: unknown): void {
  // biome-ignore lint/correctness/useExhaustiveDependencies: dep (the language) intentionally re-arms the observer — a language switch remounts the keyed cards, which need a live observer to reveal again
  useEffect(() => {
    const els = Array.from(document.querySelectorAll(".reveal"));
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
      for (const el of els) el.classList.add("is-in");
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        for (const en of entries) {
          if (en.isIntersecting) {
            en.target.classList.add("is-in");
            io.unobserve(en.target);
          }
        }
      },
      { threshold: 0.15 },
    );
    for (const el of els) io.observe(el);
    return () => io.disconnect();
  }, [dep]);
}

// ---------------------------------------------------------------------------
// Bilingual copy (user 2026-07-07): auto-detected from the browser language,
// with a nav toggle persisted in localStorage. The embedded demo follows the
// site language too (2026-07-15) — ?lang= into the iframe renders the matching
// app; EN speaks English and opens silent (there is no EN voice clip).
// ---------------------------------------------------------------------------

type Lang = "zh" | "en";
const LANG_KEY = "herta-site-lang";

function detectLang(): Lang {
  try {
    const saved = localStorage.getItem(LANG_KEY);
    if (saved === "zh" || saved === "en") return saved;
  } catch {
    // storage unavailable — fall through to navigator detection
  }
  return navigator.language.toLowerCase().startsWith("zh") ? "zh" : "en";
}

// Theme (2026-07-16): follow-OS default with a nav toggle persisted in
// localStorage — the exact mechanism the language toggle uses, and the same
// semantics as the app's own "system" theme preference. index.html carries a
// pre-hydration copy of this detection so dark-OS visitors never see a light
// flash. The embedded demo follows via ?theme= (see DemoFrame).
type Theme = "light" | "dark";
const THEME_KEY = "herta-site-theme";
const DARK_QUERY = "(prefers-color-scheme: dark)";

function detectTheme(): Theme {
  try {
    const saved = localStorage.getItem(THEME_KEY);
    if (saved === "light" || saved === "dark") return saved;
  } catch {
    // storage unavailable — fall through to the OS preference
  }
  return window.matchMedia(DARK_QUERY).matches ? "dark" : "light";
}

interface Card {
  readonly title: string;
  readonly sub: string;
  readonly body: string;
}
interface GroundingCard extends Card {
  readonly impl: string;
  readonly wide?: boolean;
}

interface SiteCopy {
  readonly navWhy: string;
  readonly navSelf: string;
  readonly navMech: string;
  readonly navTech: string;
  readonly navDl: string;
  readonly langToggle: string;
  /** aria-label for the theme toggle (the visible face is a glyph). */
  readonly themeToggleLabel: string;
  readonly eyebrow: string;
  readonly h1a: string;
  readonly h1b: string;
  readonly heroEn: string;
  readonly sub: React.ReactNode;
  readonly ctaDl: string;
  readonly ctaGh: string;
  readonly tryHint: string;
  readonly demoPosterNote: string;
  readonly whyKicker: string;
  readonly whyH2: string;
  readonly whyLead: string;
  readonly flips: readonly { no: string; yes: string }[];
  readonly selfKicker: string;
  readonly selfH2: string;
  readonly selfLead: string;
  readonly implLabel: string;
  readonly grounding: readonly GroundingCard[];
  readonly mechKicker: string;
  readonly mechH2: string;
  readonly turnTitle: string;
  readonly turnSub: string;
  readonly turnCaption: React.ReactNode;
  readonly turnAlt: string;
  readonly dreamTitle: string;
  readonly dreamSub: string;
  readonly dreamCaption: string;
  readonly dreamAlt: string;
  readonly visionAlt: string;
  readonly techKicker: string;
  readonly techH2: string;
  readonly research: readonly Card[];
  readonly dlH2: string;
  readonly dlBody: string;
  readonly dlBtnWin: string;
  readonly dlBtnMac: string;
  readonly dlGh: string;
  /** Third download button when a language has a mirror to offer. Null keeps
   *  the GitHub link — the two are alternatives, not additions, because a
   *  fourth chip wraps the row to two lines on a phone. */
  readonly dlPan: string | null;
  readonly dlFine: string;
  readonly footer: string;
  /** Attribution + non-endorsement (audit S12). Its own footer line, never
   *  appended to the © line — tacked onto an ownership assertion it reads as a
   *  continuation of that claim, which is the opposite of what it says. */
  readonly fanNotice: string;
  /** Visually hidden until focused — the keyboard escape past the demo. */
  readonly skipDemo: string;
}

const ZH: SiteCopy = {
  navWhy: "为什么",
  navSelf: "自我与记忆",
  navMech: "机制",
  navTech: "技术",
  navDl: "下载",
  langToggle: "EN",
  themeToggleLabel: "切换昼夜主题",
  eyebrow: "the self that uses the agent · desktop",
  h1a: "给自我以模型，",
  h1b: "而不是给模型以自我。",
  heroEn: "Give the model to a self — not a self to the model.",
  sub: (
    <>
      你和<b>黑塔</b>通过终端交流——负责执行编码任务的协处理器，由你们共享。
    </>
  ),
  ctaDl: "下载桌面版",
  ctaGh: "GitHub",
  tryHint: "接入空间站，跟她说句话试试。",
  demoPosterNote: "可交互演示需要桌面浏览器——这是她工作时的样子。",
  whyKicker: "为什么 · why a self",
  whyH2: "扮演与自我。",
  whyLead:
    "角色扮演的问题不在效果，在姿态：无论提示词写得多好，聊天协议都在暗示「模型在扮演一个角色」。风格可以服从，自我难以累积。",
  flips: [
    { no: "「关于她」的说明书", yes: "「由她写」的自传" },
    { no: "扮演一个角色", yes: "续写同一个说话者" },
    { no: "记忆无限追加", yes: "多层记忆，像人一样沉淀" },
  ],
  selfKicker: "自我与记忆 · on self and memory",
  selfH2: "什么是自我，什么是记忆。",
  selfLead:
    "关于这两个问题，哲学与心理学已经给出足够清晰的答案。黑塔不借它们作比喻，而是把答案当作规格来实现——",
  implLabel: "在黑塔中",
  grounding: [
    {
      title: "自我是被叙述出来的",
      sub: "the narrative self",
      body:
        "同一性不系于身体或某种实体，而系于意识与记忆的连续。更进一步：自我不是先存在、" +
        "再讲故事——人是在把经验编入自己那个故事的过程中，成为自己的。",
      impl:
        "她的提示词就是那份自述：身份、记忆、世界、正在发生的现在。推理即叙述的延续——" +
        "同一性不靠声明维持，靠续写维持。",
    },
    {
      title: "记忆是重构，不是回放",
      sub: "remembering as reconstruction",
      body:
        "回忆不是录像回放，而是按意义的重构；每一次被唤起，记忆都会短暂变得可塑，" +
        "再被重新写入。",
      impl:
        "超长会话由她以第一人称重述旧章节，保留事实；而被新经验唤起的旧记忆，" +
        "会被重新蒸馏，而不是简单追加一条新的记录。",
    },
    {
      title: "自我为记忆把关",
      sub: "the self gates memory",
      body:
        "什么会被记住，由当下的自我参与决定：与自我一致的经验才被编码保留，而积累下来的" +
        "记忆又反过来约束自我——两者互相塑造。",
      impl:
        "通过入梦的门控实现：「值得记吗」的判定与语言特征同时评审——不像她的记忆，不会被记录。" +
        "令人印象深刻的经历记忆更久：收录时估计情绪强度，强烈的记忆衰减更慢。" +
        "记忆与人格互相塑造，而非单向堆叠。",
    },
    {
      title: "遗忘是记忆的功能",
      sub: "forgetting is functional",
      body:
        "遗忘不是记忆的故障，而是它的整理方式：追踪使用价值，让重要的东西保持可及。" +
        "没有遗忘的记忆，没有轻重。",
      impl:
        "记忆会随时间变淡；被再次讲起、或她再次用上其中说法的记忆会得到巩固。写满时，" +
        "与其他记忆重复的先被遗忘，其次才是最久远的。无限追加的记忆流没有轻重；" +
        "有选择的记忆，才构成一个可辨认的人。",
    },
    {
      title: "情节沉淀为认识",
      sub: "episodes fade into knowledge",
      wide: true,
      body:
        "时间磨掉的是具体情节，不是全部：淡去的经历会沉淀为关于「这个人」的一般性认识" +
        "——记忆研究称之为从情节记忆到语义记忆的转化。",
      impl:
        "记忆被遗忘之前，其中关于你的认识会先蒸馏进她的自传：" +
        "几句话，整页重写而非追加。被反复印证而趋于稳固的记忆不必等到淡去" +
        "——其中的认识会提前沉淀。具体的情节会被忘掉，沉淀出对你的认识。",
    },
  ],
  mechKicker: "机制 · how it runs",
  mechH2: "一份记录，三个参与者；一本自传，三种时间尺度。",
  turnTitle: "一次回合",
  turnSub: " · one turn",
  turnCaption: (
    <>
      你和黑塔通过终端交流；把文件拖进会话栏，她直接读原文；记录里出现的文件，点一下就在对话旁边打开。要动代码时，她会在台词里
      <b className="banzhuan-ink">@板砖</b>
      ——那是她给编码协处理器起的名字。执行的每一步都回到同一份终端记录：
      黑塔和你一起监督任务，最后由她陈述结论。
    </>
  ),
  turnAlt: "一次回合：开拓者、黑塔与差分协处理器围绕同一份终端记录协作",
  dreamTitle: "入梦",
  dreamSub: " · she dreams, therefore she remembers",
  dreamCaption:
    "你离开时，她回看结束的会话：值得回忆的瞬间，经过四道门控后写入她的自传，" +
    "跟随此后的每一次交流；记忆随时间变淡、随复述而巩固，写满时与其他记忆重复的一段先被遗忘——" +
    "遗忘之前，其中关于你的认识会先沉淀进她的自传。" +
    "而当你回到一段她已回忆过的对话，相应的记忆会暂时退场——眼前的事，不算往事。",
  dreamAlt: "入梦循环：离开触发、四道门控、写入自传、下次开场随身携带",
  visionAlt:
    "她的自传：身份、记忆、世界、现在——三个时间尺度的循环持续续写同一份第一人称文本",
  techKicker: "技术要点 · technical notes",
  techH2: "四个设计决定。",
  research: [
    {
      title: "叙事补全基座",
      sub: "completion as identity",
      body:
        "聊天模板携带非中立的先验：角色模板持续提示「在扮演」。本系统里说话的是她这个自我，" +
        "没有 system/assistant 模板，而是在她自己的终端记录上做补全，推理目标是作为同一说话者" +
        "继续该记录。人格由此来自延续性，而非指令服从。",
    },
    {
      title: "门控记忆固化",
      sub: "gated memory consolidation",
      body:
        "跨会话记忆不是追加式记忆流，而是带门控的蒸馏管线：值得性判定、声音评审、查重与" +
        "再固化、半衰期与容量上限。遗忘是设计目标——容量约束迫使记忆保持选择性。",
    },
    {
      title: "自我-智能体分离",
      sub: "self–agent separation",
      body:
        "人的阅读、理解速度是不变量。编码后端与「她」之间的非对称边界，正是铺设在这条" +
        "不变量上：后端智能体不直接面向你会话；她不预处理任务。" +
        "二者共享同一份记录——你与「她」交流，「她」审查智能体，同一空间中协同交互。",
    },
    {
      title: "记忆的三个出口",
      sub: "a three-exit memory economy",
      body:
        "记忆架上的记录有三种去向：被重复情节唤起时再固化，锐化后替换原记录；因容量或衰减" +
        "被遗忘时，关于你的认识先沉淀为一页整页重写、有硬性篇幅上限的语义记录；其余归档休眠。" +
        "语义页没有半衰期，因此每次入梦都由活跃的记忆校对它——只修订被清楚驳斥的句子。",
    },
  ],
  dlH2: "装回你的桌面",
  dlBody: "Windows / macOS 安装包，配好 DeepSeek API 密钥，开始旅程。",
  dlBtnWin: "Windows 版",
  dlBtnMac: "macOS 版",
  dlGh: "源码 · GitHub",
  dlPan: "百度网盘",
  // Says where the turns actually GO. The previous 「不联网不上传」 was simply
  // untrue — every turn is POSTed to api.deepseek.com and carries tool
  // results, i.e. file contents. There is no local-inference path in the
  // product (audit 2026-08-05, B2). README.md already had the honest framing
  // ("Nothing is uploaded anywhere ELSE") — this restores the qualifier.
  dlFine:
    "Windows 10/11 x64 · macOS 12+ · 对话经 DeepSeek API 处理，除此之外不上传；密钥加密存本机",
  footer: "· 本页的演示由应用自身的渲染器驱动 — the demo IS the product.",
  fanNotice:
    "黑塔是《崩坏：星穹铁道》的角色，版权归米哈游所有。本项目为非官方同人作品，与米哈游无关，亦未获其认可。",
  skipDemo: "跳过演示，继续阅读",
};

const EN: SiteCopy = {
  navWhy: "Why",
  navSelf: "Self & memory",
  navMech: "Mechanisms",
  navTech: "Technical",
  navDl: "Download",
  langToggle: "中",
  themeToggleLabel: "Toggle light / dark theme",
  eyebrow: "the self that uses the agent · desktop",
  h1a: "Give the model to a self,",
  h1b: "not a self to the model.",
  heroEn: "给自我以模型，而不是给模型以自我。",
  sub: (
    <>
      You and <b>Herta</b> talk through a terminal — and share the coprocessor
      that executes the coding work.
    </>
  ),
  ctaDl: "Download the desktop app",
  ctaGh: "GitHub",
  tryHint: "Connect to the station and say something to her.",
  demoPosterNote:
    "The live demo needs a desktop browser — this is her at work.",
  whyKicker: "why a self · 自我，而非扮演",
  whyH2: "Role-play, versus a self.",
  whyLead:
    "The problem with role-play is not quality but posture: however good the prompt, the chat protocol keeps whispering that a model is playing a part. Style can comply; a self struggles to accumulate.",
  flips: [
    { no: "a manual about her", yes: "an autobiography by her" },
    { no: "playing a role", yes: "continuing as the same speaker" },
    {
      no: "an endlessly appended log",
      yes: "layered memory that settles, like a person's",
    },
  ],
  selfKicker: "on self and memory · 自我与记忆",
  selfH2: "What a self is. What memory is.",
  selfLead:
    "Philosophy and psychology have given both questions serviceable answers. Herta does not borrow them as metaphor — it implements them as a specification —",
  implLabel: "in herta",
  grounding: [
    {
      title: "The self is narrated",
      sub: "自我是被叙述出来的",
      body:
        "Identity does not rest on the body or on some substance, but on the continuity of " +
        "consciousness and memory. Further: a self does not exist first and then tell its story — " +
        "a person becomes who they are by weaving experience into that story.",
      impl:
        "Her prompt is that self-narration: identity, memory, world, the unfolding present. " +
        "Inference is the narration continuing — identity maintained by writing on, not by declaration.",
    },
    {
      title: "Remembering is reconstruction",
      sub: "记忆是重构，不是回放",
      body:
        "Recall is not playback but reconstruction by meaning; each retrieval briefly makes a " +
        "memory malleable before it is written back.",
      impl:
        "Marathon sessions are never truncated: she retells the old chapters in the first person, " +
        "promises and facts preserved. Old memories reawakened by new experience are re-distilled, " +
        "not duplicated.",
    },
    {
      title: "The self gates memory",
      sub: "自我为记忆把关",
      body:
        "What gets remembered is partly decided by the present self: experience consistent with " +
        "the self is encoded and kept, and the accumulated store constrains the self in turn — " +
        "the two shape each other.",
      impl:
        "Implemented as the dream gates: a worthiness judgment and a linguistic review run " +
        "together — a memory that doesn't sound like her is not recorded. Memorable experiences " +
        "last longer: emotional intensity is estimated at encoding, and intense memories decay " +
        "more slowly. Memory and persona shape each other, rather than simply stacking up.",
    },
    {
      title: "Forgetting is functional",
      sub: "遗忘是记忆的功能",
      body:
        "Forgetting is not a defect of memory but its housekeeping: it tracks use-value so that " +
        "what matters stays reachable. Memory without forgetting has no weight.",
      impl:
        "Memories fade with time; a memory retold — or whose words she reaches for again — grows " +
        "firmer. When the shelf is full, redundant memories are forgotten first, the oldest after. An " +
        "endlessly appended stream has no weight — selective memory is what makes a recognizable person.",
    },
    {
      title: "Episodes fade into knowledge",
      sub: "情节沉淀为认识",
      wide: true,
      body:
        "Time wears away the episode, not everything: fading experience settles into general " +
        "knowledge of the person — what memory research calls the episodic-to-semantic transition.",
      impl:
        "Before a memory is forgotten, what it says about you is distilled into her autobiography: " +
        "a few sentences, rewritten whole rather than appended. A memory confirmed " +
        "often enough settles its knowledge early, without waiting to fade. The episode is " +
        "forgotten; what settles out is the knowledge of you.",
    },
  ],
  mechKicker: "how it runs · 机制",
  mechH2:
    "One record, three participants; one autobiography, three timescales.",
  turnTitle: "One turn",
  turnSub: " · 一次回合",
  turnCaption: (
    <>
      You and Herta talk through the terminal; drop a file into the composer and
      she reads the original; any file the record names opens beside the
      conversation with a click. When code needs touching, she writes{" "}
      <b className="banzhuan-ink">@Brick</b> in her line — her name for the
      coding coprocessor. Every step of execution returns to the same terminal
      record: Herta supervises the task with you, and states the conclusion
      herself.
    </>
  ),
  turnAlt:
    "One turn: the Trailblazer, Herta, and the Coprocessor collaborating around one shared terminal record",
  dreamTitle: "Dreaming",
  dreamSub: " · she dreams, therefore she remembers",
  dreamCaption:
    "When you step away, she looks back over the finished sessions: moments worth remembering " +
    "pass four gates into her autobiography and ride along in every later conversation. Memory " +
    "fades with time and firms with retelling; when it fills, the redundant chapter is forgotten " +
    "first — but before that, what it knew about you settles " +
    "into her autobiography. And when you return to a conversation she has already dreamed " +
    "about, those memories quietly step aside — what is still on the screen is not yet the past.",
  dreamAlt:
    "The dream cycle: triggered while away, four gates, written into her autobiography, carried into the next opening",
  visionAlt:
    "Her autobiography: identity, memory, world, present — loops on three timescales keep writing one first-person text",
  techKicker: "technical notes · 技术要点",
  techH2: "Four design decisions.",
  research: [
    {
      title: "Narrative completion substrate",
      sub: "叙事补全基座",
      body:
        "Chat templates carry a non-neutral prior: the role template keeps suggesting " +
        "something playing a part. The self here has no system/assistant templates — " +
        "she completes her own terminal record, with the objective of continuing it as the same " +
        "speaker. Persona arises from continuity, not compliance.",
    },
    {
      title: "Gated memory consolidation",
      sub: "门控记忆固化",
      body:
        "Cross-session memory is not an appended stream but a gated distillation pipeline: " +
        "worthiness judgment, voice review, dedup and reconsolidation, retention half-life and a " +
        "capacity cap. Forgetting is a design goal — the capacity constraint forces memory to " +
        "stay selective.",
    },
    {
      title: "Self–agent separation",
      sub: "自我-智能体分离",
      body:
        "A person's reading and comprehension speed is the invariant. The asymmetric boundary " +
        "between the coding backend and her is laid down precisely on that invariant: the backend " +
        "agent never talks to you directly; she does not pre-digest tasks. Both share one " +
        "record — you talk with her, and she reviews the agent, collaborating in one space.",
    },
    {
      title: "A three-exit memory economy",
      sub: "记忆的三个出口",
      body:
        "A record on the shelf leaves one of three ways: reconsolidated when a recurring episode " +
        "sharpens it; distilled — before being forgotten under capacity or decay — into a " +
        "whole-rewritten, hard-capped semantic page about you; or archived dormant. The " +
        "semantic page has no half-life, so each dream pass lets active memories audit it, " +
        "revising only clearly refuted sentences.",
    },
  ],
  dlH2: "Back to your desktop",
  dlBody:
    "Installers for Windows and macOS. Add a DeepSeek API key — and the journey begins.",
  dlBtnWin: "For Windows",
  dlBtnMac: "For macOS",
  dlGh: "Source · GitHub",
  // No Baidu Pan for EN: it needs an account and is slow outside China, so
  // GitHub Releases is the better link for these visitors.
  dlPan: null,
  // See the zh note above — "fully local" was false; turns go to DeepSeek.
  dlFine:
    "Windows 10/11 x64 · macOS 12+ · your turns go to the DeepSeek API and nowhere else — your key is encrypted on your machine",
  footer:
    "· the demo on this page runs the app's own renderer — the demo IS the product.",
  fanNotice:
    "Herta is a character from Honkai: Star Rail, © HoYoverse. Unofficial fan project, unaffiliated with and not endorsed by HoYoverse.",
  skipDemo: "Skip the demo",
};

const COPY: Record<Lang, SiteCopy> = { zh: ZH, en: EN };

export function Site(): JSX.Element {
  const [lang, setLang] = useState<Lang>(detectLang);
  const t = COPY[lang];
  useReveal(lang);
  // Keep the document's declared language honest — index.html ships a static
  // zh-CN default, but screen readers and translators should see the active one.
  useEffect(() => {
    document.documentElement.lang = lang === "zh" ? "zh-CN" : "en";
  }, [lang]);
  const toggleLang = () => {
    const next: Lang = lang === "zh" ? "en" : "zh";
    setLang(next);
    try {
      localStorage.setItem(LANG_KEY, next);
    } catch {
      // storage unavailable — the choice just doesn't persist
    }
  };
  const [theme, setTheme] = useState<Theme>(detectTheme);
  // Stamp <html data-theme> (the CSS dark block keys on it; index.html made
  // the same stamp pre-hydration, so this is a no-op on first paint).
  useEffect(() => {
    if (theme === "dark") {
      document.documentElement.dataset.theme = "dark";
    } else {
      delete document.documentElement.dataset.theme;
    }
  }, [theme]);
  // Follow-OS while the visitor has NOT chosen manually: an OS theme change
  // retracks live; a saved choice pins it (same rule as the app's "system").
  useEffect(() => {
    const mq = window.matchMedia(DARK_QUERY);
    const onChange = () => {
      try {
        if (localStorage.getItem(THEME_KEY) !== null) return; // pinned
      } catch {
        // storage unavailable → nothing can be pinned; keep following
      }
      setTheme(mq.matches ? "dark" : "light");
    };
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  const toggleTheme = () => {
    const next: Theme = theme === "dark" ? "light" : "dark";
    setTheme(next);
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {
      // storage unavailable — the choice just doesn't persist
    }
  };
  return (
    <div className="site">
      <nav className="site-nav">
        <div className="site-inner">
          <a className="site-wordmark" href="#top">
            <span className="icon-tile icon-tile--nav">
              <img src={hertaIcon} alt="" />
            </span>
            {/* The trailer's end-card lockup (owner 2026-08-03: the bold
                黑塔·HERTA read as template branding): thin letterspaced
                HERTA over a small wide-tracked 黑塔, centered. */}
            <span className="wordmark-lockup">
              <span className="wordmark-en">HERTA</span>
              <span className="wordmark-cn">黑塔</span>
            </span>
          </a>
          <a className="nav-link" href="#why">
            {t.navWhy}
          </a>
          <a className="nav-link" href="#self">
            {t.navSelf}
          </a>
          <a className="nav-link" href="#mechanisms">
            {t.navMech}
          </a>
          <a className="nav-link" href="#research">
            {t.navTech}
          </a>
          <a className="nav-link" href="#download">
            {t.navDl}
          </a>
          <button className="nav-lang" type="button" onClick={toggleLang}>
            {t.langToggle}
          </button>
          <button
            className="nav-lang nav-theme"
            type="button"
            onClick={toggleTheme}
            aria-label={t.themeToggleLabel}
            title={t.themeToggleLabel}
          >
            {/* The face shows the TARGET theme, like the lang toggle. */}
            {theme === "dark" ? <SunIcon /> : <MoonIcon />}
          </button>
          <a
            className="nav-gh"
            href={REPO_URL}
            target="_blank"
            rel="noreferrer"
          >
            GitHub
          </a>
        </div>
      </nav>

      <header className="hero" id="top">
        <div className="site-inner">
          <span className="icon-tile icon-tile--hero reveal">
            <img src={hertaIcon} alt="Herta" />
          </span>
          <p className="eyebrow reveal">{t.eyebrow}</p>
          <h1 className="reveal">
            {t.h1a}
            <br />
            {t.h1b}
          </h1>
          <p className="hero-en reveal">{t.heroEn}</p>
          <p className="sub reveal">{t.sub}</p>
          <div className="cta-row reveal">
            {/* Scrolls to the download card rather than leaving for GitHub:
                the hero button is platform-neutral, and the card below is
                where the Windows/macOS choice actually lives. Sending someone
                straight to the releases list made them pick a build with no
                context. Same target as the nav's 下载 link; html already
                smooth-scrolls, gated off for prefers-reduced-motion. */}
            <a className="cta-dl" href="#download">
              <DownloadIcon />
              {t.ctaDl}
            </a>
            <a
              className="cta-gh"
              href={REPO_URL}
              target="_blank"
              rel="noreferrer"
            >
              {t.ctaGh}
            </a>
          </div>
          <p className="try-hint reveal">{t.tryHint}</p>
        </div>
        {/* The demo is a real, interactive app in an iframe — measured as tab
            stop 11, with only two links after it. Without an escape a
            keyboard user has to traverse the entire embedded application
            (composer, sidebar, settings) to reach the rest of the page, and
            `inert` is not an option here because the demo being usable is the
            whole point (audit BL25). Hidden until focused. */}
        <a className="skip-demo" href="#why">
          {t.skipDemo}
        </a>
        <div className="demo-outer">
          <DemoFrame posterNote={t.demoPosterNote} lang={lang} theme={theme} />
        </div>
      </header>

      <section className="section" id="why">
        <div className="site-inner">
          <p className="kicker reveal">{t.whyKicker}</p>
          <h2 className="reveal">{t.whyH2}</h2>
          <p className="section-lead reveal">{t.whyLead}</p>
          <div className="flip-list reveal">
            {t.flips.map((f) => (
              <div className="flip" key={f.yes}>
                <span className="flip-no">{f.no}</span>
                <span className="flip-arrow" aria-hidden="true">
                  →
                </span>
                <span className="flip-yes">{f.yes}</span>
              </div>
            ))}
          </div>
          <figure className="diagram reveal">
            {/* The diagrams follow the site language like the demo poster:
                hand-authored -en twins, since the text lives inside the SVG. */}
            <img
              src={lang === "en" ? visionSvgEn : visionSvg}
              alt={t.visionAlt}
            />
          </figure>
        </div>
      </section>

      <section className="section" id="self">
        <div className="site-inner">
          <p className="kicker reveal">{t.selfKicker}</p>
          <h2 className="reveal">{t.selfH2}</h2>
          <p className="section-lead reveal">{t.selfLead}</p>
          <div className="scholar-grid">
            {t.grounding.map((g) => (
              <div
                className={`scholar-card reveal${g.wide === true ? " scholar-card--wide" : ""}`}
                key={g.sub}
              >
                <h3>
                  {g.title}
                  <span className="en">{g.sub}</span>
                </h3>
                <p className="scholar-theory">{g.body}</p>
                <p className="scholar-impl">
                  <span className="impl-label">{t.implLabel}</span>
                  {g.impl}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="section" id="mechanisms">
        <div className="site-inner">
          <p className="kicker reveal">{t.mechKicker}</p>
          <h2 className="reveal">{t.mechH2}</h2>
          <div className="mech-block reveal">
            <h3 className="mech-title">
              {t.turnTitle}
              <span className="en">{t.turnSub}</span>
            </h3>
            <p className="mech-caption">{t.turnCaption}</p>
            <figure className="diagram">
              <img
                src={lang === "en" ? turnFlowSvgEn : turnFlowSvg}
                alt={t.turnAlt}
              />
            </figure>
          </div>
          <div className="mech-block reveal">
            <h3 className="mech-title">
              {t.dreamTitle}
              <span className="en">{t.dreamSub}</span>
            </h3>
            <p className="mech-caption">{t.dreamCaption}</p>
            <figure className="diagram">
              <img
                src={lang === "en" ? dreamCycleSvgEn : dreamCycleSvg}
                alt={t.dreamAlt}
              />
            </figure>
          </div>
        </div>
      </section>

      <section className="section" id="research">
        <div className="site-inner">
          <p className="kicker reveal">{t.techKicker}</p>
          <h2 className="reveal">{t.techH2}</h2>
          <div className="feature-grid feature-grid--two">
            {t.research.map((r) => (
              <div className="feature-card reveal" key={r.sub}>
                <h3>
                  {r.title}
                  <span className="en">{r.sub}</span>
                </h3>
                <p>{r.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="section" id="download">
        <div className="site-inner">
          <div className="download-card reveal">
            <h2>{t.dlH2}</h2>
            <p>{t.dlBody}</p>
            <div className="cta-row">
              <a
                className="cta-dl"
                href={DOWNLOAD_URL}
                target="_blank"
                rel="noreferrer"
              >
                <DownloadIcon />
                {t.dlBtnWin}
              </a>
              <a
                className="cta-dl"
                href={DOWNLOAD_URL}
                target="_blank"
                rel="noreferrer"
              >
                <DownloadIcon />
                {t.dlBtnMac}
              </a>
              {t.dlPan === null ? (
                <a
                  className="cta-gh"
                  href={REPO_URL}
                  target="_blank"
                  rel="noreferrer"
                >
                  {t.dlGh}
                </a>
              ) : (
                <a
                  className="cta-gh"
                  href={PAN_URL}
                  target="_blank"
                  rel="noreferrer"
                >
                  {t.dlPan}
                </a>
              )}
            </div>
            <p className="fine">{t.dlFine}</p>
          </div>
        </div>
      </section>

      <footer className="site-footer">
        <div className="site-inner">
          <span className="icon-tile icon-tile--footer">
            <img src={hertaIcon} alt="" />
          </span>
          <p>
            © 2026 PersonaCLI ·{" "}
            <a href={REPO_URL} target="_blank" rel="noreferrer">
              Herta
            </a>{" "}
            {t.footer}
          </p>
          <p className="site-footer__fan">{t.fanNotice}</p>
        </div>
      </footer>
    </div>
  );
}
