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
// The desk section's pictures (2026-09-10, owner: "flat device images
// instead of 3D models"): the device card is the REAL scene rendered at four
// hours through the release film's driven mode (trailer-materials/film,
// DeviceStill) — the site loads no three.js and none of the scene's assets;
// the repository card and the commit tab are the desktop app itself over
// CDP, per theme; her speaking is the app's composer and bubble from the
// same film kit, per language and theme. All WebP, 8–45 KB each.
import deviceDusk from "./assets/device-dusk.webp";
import deviceMorning from "./assets/device-morning.webp";
import deviceNight from "./assets/device-night.webp";
import deviceNoon from "./assets/device-noon.webp";
import dreamCycleSvg from "./assets/dream-cycle.svg";
import dreamCycleSvgEn from "./assets/dream-cycle-en.svg";
import gitCardDark from "./assets/feature-git-card-dark.webp";
import gitCardLight from "./assets/feature-git-card-light.webp";
import gitCommitDark from "./assets/feature-git-commit-dark.webp";
import gitCommitLight from "./assets/feature-git-commit-light.webp";
import voiceEnDark from "./assets/feature-voice-en-dark.webp";
import voiceEnLight from "./assets/feature-voice-en-light.webp";
import voiceZhDark from "./assets/feature-voice-zh-dark.webp";
import voiceZhLight from "./assets/feature-voice-zh-light.webp";
// 256² WebP (25 KB) in place of the 512² palette PNG (59 KB): the tile shows
// it at 84 CSS px at most.
import hertaIcon from "./assets/herta-icon.webp";
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

/** The device's day: four renders of the real scene, crossfading on a slow
 *  loop (CSS; reduced motion holds the first). The pictures are the scene at
 *  7:30, 12:30, 18:30 and 22:30 — the card's chrome follows the theme the app
 *  would be in at that hour. */
const DEVICE_DAY = [
  deviceMorning,
  deviceNoon,
  deviceDusk,
  deviceNight,
] as const;

function DeskPicture(props: {
  readonly id: DeskCard["id"];
  readonly alt: string;
  readonly lang: Lang;
  readonly theme: Theme;
  readonly hours: readonly [string, string, string, string];
}): JSX.Element {
  const dark = props.theme === "dark";
  if (props.id === "device") {
    return (
      <figure className="desk-card__pic device-cycle" aria-label={props.alt}>
        {DEVICE_DAY.map((src, i) => (
          <img
            key={src}
            src={src}
            alt={i === 0 ? props.alt : ""}
            aria-hidden={i !== 0}
            loading="lazy"
            decoding="async"
            style={{ animationDelay: `${-i * 5}s` }}
          />
        ))}
        <figcaption>
          {props.hours.map((h, i) => (
            <span key={h} style={{ animationDelay: `${-i * 5}s` }}>
              {h}
            </span>
          ))}
        </figcaption>
      </figure>
    );
  }
  if (props.id === "git") {
    return (
      <figure className="desk-card__pic desk-card__pic--two">
        <img
          src={dark ? gitCardDark : gitCardLight}
          alt={props.alt}
          loading="lazy"
          decoding="async"
        />
        <img
          src={dark ? gitCommitDark : gitCommitLight}
          alt=""
          aria-hidden="true"
          loading="lazy"
          decoding="async"
        />
      </figure>
    );
  }
  const voice =
    props.lang === "en"
      ? dark
        ? voiceEnDark
        : voiceEnLight
      : dark
        ? voiceZhDark
        : voiceZhLight;
  return (
    <figure className="desk-card__pic">
      <img src={voice} alt={props.alt} loading="lazy" decoding="async" />
    </figure>
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
/** One of the desk section's three features; the picture is chosen by
 *  the JSX from `id`, the words come from the copy. */
interface DeskCard extends Card {
  readonly id: "device" | "git" | "voice";
  readonly alt: string;
}

interface SiteCopy {
  readonly navWhy: string;
  readonly navSelf: string;
  readonly navMech: string;
  readonly navDesk: string;
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
  /** Under each diagram on a narrow screen: the diagrams keep a legible
   *  880-px width and scroll sideways inside their frame, which a phone
   *  gives no sign of (2026-09-24). */
  readonly diagramHint: string;
  readonly deskKicker: string;
  readonly deskH2: string;
  readonly deskLead: string;
  readonly desk: readonly DeskCard[];
  /** The four moments of the device's day, in the crossfade's order. */
  readonly deskHours: readonly [string, string, string, string];
  readonly techKicker: string;
  readonly techH2: string;
  readonly research: readonly Card[];
  readonly dlH2: string;
  readonly dlBody: string;
  readonly dlBtnWin: string;
  readonly dlBtnMac: string;
  readonly dlBtnLinux: string;
  readonly dlGh: string;
  /** Last chip when a language has a mirror to offer. Null keeps the GitHub
   *  link — the two are alternatives, not additions, so the row never grows
   *  past four chips (three platforms since v0.1.6, plus this one). */
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
  navDesk: "终端",
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
      你通过终端与<b>黑塔</b>
      对话。编码任务由她交给协处理器执行，每一步你们都看得到。
    </>
  ),
  ctaDl: "下载桌面版",
  ctaGh: "GitHub",
  tryHint: "接入空间站，跟她说句话试试。",
  demoPosterNote: "可交互演示请用桌面浏览器打开。下图是她工作时的界面。",
  whyKicker: "为什么 · why a self",
  whyH2: "扮演与自我。",
  whyLead:
    "常见的做法是给模型一段角色设定，让它照着设定说话。提示词写得再好，聊天格式本身也在不断提醒模型：你在扮演一个角色。它能学会说话的风格，却很难积累出一个持续存在的自我。",
  flips: [
    { no: "「关于她」的说明书", yes: "「由她写」的自传" },
    { no: "扮演一个角色", yes: "续写同一个说话者" },
    { no: "记忆无限追加", yes: "多层记忆，像人一样沉淀" },
  ],
  selfKicker: "自我与记忆 · on self and memory",
  selfH2: "什么是自我，什么是记忆。",
  selfLead:
    "哲学和心理学对这两个问题已有相当清楚的回答。黑塔把这些回答当作设计要求来实现：",
  implLabel: "在黑塔中",
  grounding: [
    {
      title: "自我是被叙述出来的",
      sub: "the narrative self",
      body:
        "一个人之所以始终是同一个人，靠的是意识与记忆的连续。人把经历一段段编进关于自己的故事，" +
        "自我就在这个过程中形成。",
      impl:
        "她的提示词就是这份自述，依次是身份、记忆、世界和当下。每一次推理，" +
        "都是在这份自述后面接着往下写。",
    },
    {
      title: "回忆是重构",
      sub: "remembering as reconstruction",
      body:
        "回忆时，人会按意义把当时的经历重新组织一遍。记忆每被唤起一次，都会短暂地变得可以修改，" +
        "然后再被存回去。",
      impl:
        "会话太长时，她用第一人称重述较早的部分，尽量保留其中的事实与承诺；完整的记录仍保存在本地。" +
        "新的经历唤起相似的旧记忆时，旧记忆会被加强，或与新经历合并改写。",
    },
    {
      title: "自我为记忆把关",
      sub: "the self gates memory",
      body:
        "记住什么，部分取决于当下的自我：与自我相符的经历更容易被保留。积累下来的记忆，" +
        "又反过来塑造自我。",
      impl:
        "入梦时，每个候选片段先判断值不值得记；写下来之后，再评审读起来像不像她。不像她的，不会写入。" +
        "收录时还会估计这段经历的情绪强度：越强烈的记忆，初始强度越高，保留得越久。",
    },
    {
      title: "遗忘是记忆的功能",
      sub: "forgetting is functional",
      body: "遗忘是记忆整理自己的方式：常用的留在手边，不常用的逐渐退后，重要的东西因此更容易找到。",
      impl:
        "她的记忆会随时间变淡。某段记忆被再次提起，或者她又用上了其中的说法，这段记忆就会得到巩固。" +
        "淡到一定程度的记忆会被遗忘；记忆写满时，同类记忆中最淡的一条先让位。",
    },
    {
      title: "情节沉淀为认识",
      sub: "episodes fade into knowledge",
      wide: true,
      body: "时间会磨掉具体的情节，但会留下对一个人的整体认识。记忆研究把这称为从情节记忆到语义记忆的转化。",
      impl:
        "一段记忆被遗忘时，其中关于你的认识会写进她的自传。这部分只有几句话，每次整页重写。" +
        "被反复印证的记忆不必等到淡去，其中的认识会提前写入。",
    },
  ],
  mechKicker: "机制 · how it runs",
  mechH2: "她如何工作，又如何记住。",
  turnTitle: "一次回合",
  turnSub: " · one turn",
  turnCaption: (
    <>
      你在终端里与黑塔对话。把文件拖进输入栏，她会看到文件的内容，长文档的全文由板砖查阅；板砖读过或改过的文件，在记录里点一下就会在对话旁边打开。需要修改代码时，她会在自己的话里写上
      <b className="banzhuan-ink">@板砖</b>
      ，这是她给编码协处理器起的名字。协处理器的每一步都写进同一份终端记录，你和黑塔都看得到，最后由她给出结论。
    </>
  ),
  turnAlt: "一次回合：开拓者、黑塔与差分协处理器围绕同一份终端记录协作",
  dreamTitle: "入梦",
  dreamSub: " · she dreams, therefore she remembers",
  dreamCaption:
    "入梦默认关闭，可在设置中开启；它会消耗你的 DeepSeek API 额度。开启后，你离开期间，" +
    "她会回顾已经结束的会话。值得记住的片段要通过几道检查：值不值得记、写下来像不像她、" +
    "是否与已有的记忆重复。通过的片段写进她的记忆，之后的每次对话都会带着。" +
    "记忆随时间变淡，被再次提起时得到巩固；淡去的记忆被遗忘时，其中关于你的认识会写进她的自传。" +
    "重新打开一段她回顾过的会话时，只要会话原文还完整地在她的上下文里，相关的记忆就先收起不用。",
  dreamAlt:
    "入梦循环：离开时触发，经过几道检查，写入记忆与自传，之后的对话随身携带",
  visionAlt:
    "她的自传分为身份、记忆、世界、当下四部分，在三种时间尺度上被持续续写",
  diagramHint: "← 左右滑动查看完整图示 →",
  deskKicker: "终端 · the live terminal",
  deskH2: "动态终端。",
  deskLead: "差分协处理器 PBR 动态渲染，Git 仓库适配，本地/云端实时语音。",
  desk: [
    {
      id: "device",
      title: "立体板砖",
      sub: "PBR 渲染 · a lit object",
      body:
        "协处理器的设备卡片按物理渲染：浅色主题下，房间的光线随本地时钟变化，深色主题是深夜。" +
        "云影掠过白色的房间，设备工作时呼吸，出错时闪烁。",
      alt: "板砖设备卡片在清晨、正午、黄昏与深夜的四张渲染",
    },
    {
      id: "git",
      title: "Git 前端",
      sub: "the repository at hand",
      body:
        "工作区适配 Git 仓库：分支与上游、未提交的改动、最近的提交，自动刷新。" +
        "点一处改动看它的差异，点一个提交看它改了什么，翻历史不用离开对话。",
      alt: "仓库卡片，以及在对话旁边打开的提交标签页",
    },
    {
      id: "voice",
      title: "实时语音",
      sub: "she speaks · in step with the text",
      body: "本地模型或云端实时语音合成，文字随语音同步显示。",
      alt: "她说话时的对话与输入栏：文字随语音显示，声波在输入栏里起伏",
    },
  ],
  deskHours: ["清晨", "正午", "黄昏", "深夜"],
  techKicker: "技术要点 · technical notes",
  techH2: "四个设计决定。",
  research: [
    {
      title: "叙事补全基座",
      sub: "completion as identity",
      body:
        "聊天格式把对话分成 system、user、assistant 几种角色，这种划分本身就在提示模型「你在扮演」。" +
        "黑塔不使用这套格式：模型拿到的是她自己的终端记录，任务是以同一个说话者的身份把记录续写下去。" +
        "她的性格因此来自前文的延续。",
    },
    {
      title: "门控记忆固化",
      sub: "gated memory consolidation",
      body:
        "跨会话的记忆要经过一条筛选流程：先判断是否值得记住，写下后与已有记忆查重，再检查口吻与忠实度。" +
        "留下的记忆按半衰期衰减，总数受容量上限约束。遗忘是有意设计的：容量有限，记忆才有取舍。",
    },
    {
      title: "自我-智能体分离",
      sub: "self–agent separation",
      body:
        "人阅读和理解的速度有限，智能体产出的细节却很多。所以编码智能体不直接与你对话，" +
        "只在共享记录里留下简短的步骤，由黑塔审阅后向你说明；黑塔也不替它预先拆解任务。" +
        "三方用的是同一份记录：你与黑塔交流，黑塔审阅智能体的工作。",
    },
    {
      title: "记忆的去向",
      sub: "where a memory goes",
      body:
        "相似的新经历唤起一段记忆时，原记忆会被加强；如果与新经历合并后的版本读起来更像她，" +
        "就替换原来那条。记忆因衰减或容量被遗忘时，文件归档而不删除，其中关于你的认识" +
        "整理进一页认识页。这一页有篇幅上限，每次整页重写，不随时间衰减，所以每次入梦都会用" +
        "最稳固的几段记忆校对它，只修改被明确推翻的句子。",
    },
  ],
  dlH2: "装到你的桌面",
  dlBody:
    "提供 Windows、macOS 与 Linux 安装包，填入 DeepSeek API 密钥即可使用。",
  dlBtnWin: "Windows 版",
  dlBtnMac: "macOS 版",
  dlBtnLinux: "Linux 版",
  dlGh: "源码 · GitHub",
  dlPan: "百度网盘",
  // Says where the turns actually GO. The previous 「不联网不上传」 was simply
  // untrue — every turn is POSTed to api.deepseek.com and carries tool
  // results, i.e. file contents. There is no local-inference path in the
  // product (audit 2026-08-05, B2). README.md already had the honest framing
  // ("Nothing is uploaded anywhere ELSE") — this restores the qualifier. The
  // cloud voice (ADR 0062) sends her lines to MiniMax, so it is named too
  // (2026-09-24).
  dlFine:
    // A no-break space before each dot keeps it at a line's end on a phone.
    "Windows 10/11 x64 · macOS 12+ · Linux x64 AppImage · 对话只发送给 DeepSeek API（开启云端语音时，她的台词另发送给 MiniMax）；密钥保存在本机，系统密钥链可用时加密",
  footer: "本页演示运行的就是应用本身的界面代码。",
  fanNotice:
    "黑塔是《崩坏：星穹铁道》的角色，版权归米哈游所有。本项目为非官方同人作品，与米哈游无关，亦未获其认可。",
  skipDemo: "跳过演示，继续阅读",
};

const EN: SiteCopy = {
  navWhy: "Why",
  navSelf: "Self & memory",
  navMech: "Mechanisms",
  navDesk: "The terminal",
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
      You talk with <b>Herta</b> in a terminal. She hands the coding work to a
      coprocessor, and you both see every step it takes.
    </>
  ),
  ctaDl: "Download the desktop app",
  ctaGh: "GitHub",
  tryHint: "Connect to the station and say something to her.",
  demoPosterNote:
    "The live demo needs a desktop browser. Below is what she looks like at work.",
  whyKicker: "why a self · 自我，而非扮演",
  whyH2: "Role-play, versus a self.",
  whyLead:
    "The usual approach gives a model a character sheet and asks it to stay in character. However good the prompt, the chat format itself keeps telling the model that it is playing a part. It can learn the style, but it has a hard time building a self that lasts.",
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
    "Philosophy and psychology have fairly clear answers to both questions. Herta takes those answers as design requirements and implements them:",
  implLabel: "in herta",
  grounding: [
    {
      title: "The self is narrated",
      sub: "自我是被叙述出来的",
      body:
        "What keeps a person the same person over time is the continuity of consciousness and " +
        "memory. People weave their experiences, one by one, into a story about themselves, and " +
        "the self takes shape in that telling.",
      impl:
        "Her prompt is that story, in four parts: identity, memory, world, and the present. " +
        "Each inference continues writing it.",
    },
    {
      title: "Remembering is reconstruction",
      sub: "回忆是重构",
      body:
        "Recall rebuilds an experience from what it meant. Each time a memory is recalled, it " +
        "briefly becomes open to change, and is then stored again.",
      impl:
        "When a session runs long, she retells its earlier parts in the first person, taking care " +
        "to keep facts and promises; the full record stays on your disk. When a new experience " +
        "brings back a similar memory, the old memory is strengthened, or merged with the new " +
        "experience and rewritten.",
    },
    {
      title: "The self gates memory",
      sub: "自我为记忆把关",
      body:
        "What gets remembered depends partly on who you are now: experiences that fit the self " +
        "are more likely to be kept. The memories that build up then shape the self in turn.",
      impl:
        "While she dreams, each candidate is first judged worth keeping or not; once written, it " +
        "is reviewed for whether it reads like her. If it does not sound like her, it is not " +
        "recorded. Its emotional intensity is estimated too: the stronger it is, the firmer it " +
        "starts, and the longer it lasts.",
    },
    {
      title: "Forgetting is functional",
      sub: "遗忘是记忆的功能",
      body:
        "Forgetting is how memory keeps itself in order: what gets used stays close, what does " +
        "not drifts back, and what matters becomes easier to find.",
      impl:
        "Her memories fade with time. When one is brought up again, or she uses its wording " +
        "again, it grows firmer. A memory that fades far enough is forgotten; when memory is " +
        "full, the faintest of a group of similar memories makes way first.",
    },
    {
      title: "Episodes fade into knowledge",
      sub: "情节沉淀为认识",
      wide: true,
      body:
        "Time wears away the details of an episode but leaves a general sense of the person. " +
        "Memory research calls this the move from episodic to semantic memory.",
      impl:
        "When a memory is forgotten, what it says about you is written into her autobiography: " +
        "a few sentences, rewritten as a whole page each time. A memory confirmed often enough " +
        "passes on what it knows early, without waiting to fade.",
    },
  ],
  mechKicker: "how it runs · 机制",
  mechH2: "How she works, and how she remembers.",
  turnTitle: "One turn",
  turnSub: " · 一次回合",
  turnCaption: (
    <>
      You talk with Herta in the terminal. Drop a file into the composer and she
      sees what is in it; for a long document, Brick reads the full text. A file
      Brick has read or changed opens beside the conversation when you click it
      in the record. When code needs changing, she writes{" "}
      <b className="banzhuan-ink">@Brick</b> in her line, her name for the
      coding coprocessor. Every step it takes goes into the same terminal
      record, where you and Herta can both see it, and she gives the conclusion
      at the end.
    </>
  ),
  turnAlt:
    "One turn: the Trailblazer, Herta, and the Coprocessor collaborating around one shared terminal record",
  dreamTitle: "Dreaming",
  dreamSub: " · she dreams, therefore she remembers",
  dreamCaption:
    "Dreaming is off by default; turn it on in Settings. It uses your DeepSeek API quota. Once " +
    "it is on, she looks back over finished sessions while you are away. A moment worth keeping " +
    "has to pass several checks: is it worth remembering, does it read like her, and is it " +
    "already remembered. What passes goes into her memory and comes with her into every later " +
    "conversation. Memories fade with time and grow firmer when brought up again; when a faded " +
    "memory is forgotten, what it knew about you is written into her autobiography. When you " +
    "reopen a conversation she has dreamed about, memories of it are set aside for as long as " +
    "the conversation itself is still fully in her context.",
  dreamAlt:
    "The dream cycle: triggered while you are away, several checks, written into her memory and autobiography, carried into later conversations",
  visionAlt:
    "Her autobiography in four parts, identity, memory, world and present, written on continuously at three timescales",
  diagramHint: "← swipe sideways to see the whole diagram →",
  deskKicker: "the terminal · 终端",
  deskH2: "A live terminal.",
  deskLead:
    "The coprocessor's device rendered live in PBR, the Git repository fitted to the workspace, and real-time voice, local or cloud, in Chinese sessions.",
  desk: [
    {
      id: "device",
      title: "A lit object",
      sub: "立体板砖 · PBR",
      body:
        "The coprocessor's device card is physically rendered. In the light theme the room's " +
        "light follows your local clock; the dark theme is midnight. Clouds drift across the " +
        "white room, and the device breathes while it works and blinks when something fails.",
      alt: "The coprocessor's device card rendered at morning, noon, dusk and night",
    },
    {
      id: "git",
      title: "The repository at hand",
      sub: "Git 前端",
      body:
        "The workspace fits its Git repository: branch and upstream, uncommitted changes and " +
        "recent commits, refreshed on their own. Click a change for its diff or a commit for " +
        "what it touched, and page through the history without leaving the conversation.",
      alt: "The repository card, and a commit tab opened beside the conversation",
    },
    {
      id: "voice",
      title: "She speaks",
      sub: "实时语音 · in step with the text",
      body:
        "Real-time speech from a local model or a cloud service, with the text revealed in step " +
        "with her voice. Voice is available in Chinese sessions.",
      alt: "The conversation and the composer while she speaks: text keeping step with the voice, the wave moving in the composer",
    },
  ],
  deskHours: ["morning", "noon", "dusk", "night"],
  techKicker: "technical notes · 技术要点",
  techH2: "Four design decisions.",
  research: [
    {
      title: "Narrative completion substrate",
      sub: "叙事补全基座",
      body:
        "Chat formats split a conversation into system, user and assistant roles, and that " +
        "split keeps telling the model it is playing a part. Herta does not use that format: " +
        "the model is given her own terminal record and asked to continue it as the same " +
        "speaker. Her persona comes from that continuity.",
    },
    {
      title: "Gated memory consolidation",
      sub: "门控记忆固化",
      body:
        "Memory that lasts across sessions goes through a filter: is it worth keeping; once " +
        "written, is it already remembered; and does it keep her voice and stay faithful to what " +
        "happened. Kept memories decay on a half-life under a fixed capacity. Forgetting is " +
        "deliberate: with limited room, memory has to choose.",
    },
    {
      title: "Self–agent separation",
      sub: "自我-智能体分离",
      body:
        "People read and understand at a limited pace, and an agent produces far more detail " +
        "than that. So the coding agent does not talk to you: it leaves short steps in the " +
        "shared record, and Herta reviews them and tells you what they mean. She does not " +
        "pre-digest tasks for it either. All three work from one record: you talk with her, " +
        "and she reviews the agent's work.",
    },
    {
      title: "Where a memory goes",
      sub: "记忆的去向",
      body:
        "When a similar new experience brings a memory back, the memory is strengthened; if a " +
        "version merged with the new experience reads more like her, it replaces the old one. " +
        "When a memory is forgotten through decay or capacity, its file is archived, not " +
        "deleted, and what it knew about you goes into a knowledge page. That page has a length " +
        "cap, is rewritten whole each time, and does not decay, so every dream checks it against " +
        "her firmest memories and changes only the sentences they clearly contradict.",
    },
  ],
  dlH2: "On your desktop",
  dlBody:
    "Installers for Windows, macOS and Linux. Add a DeepSeek API key, and she is ready.",
  dlBtnWin: "For Windows",
  dlBtnMac: "For macOS",
  dlBtnLinux: "For Linux",
  dlGh: "Source · GitHub",
  // No Baidu Pan for EN: it needs an account and is slow outside China, so
  // GitHub Releases is the better link for these visitors.
  dlPan: null,
  // See the zh note above — "fully local" was false; turns go to DeepSeek.
  dlFine:
    "Windows 10/11 x64 · macOS 12+ · Linux x64 AppImage · your conversation goes only to the DeepSeek API (with cloud voice on, her lines also go to MiniMax) · your key stays on your machine, encrypted by the OS keychain when one is available",
  footer: "the demo on this page runs the app's own interface code.",
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
          <a className="nav-link" href="#desk">
            {t.navDesk}
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
                where the platform choice actually lives. Sending someone
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
          <p className="diagram-hint" aria-hidden="true">
            {t.diagramHint}
          </p>
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
            <p className="diagram-hint" aria-hidden="true">
              {t.diagramHint}
            </p>
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
            <p className="diagram-hint" aria-hidden="true">
              {t.diagramHint}
            </p>
          </div>
        </div>
      </section>

      <section className="section" id="desk">
        <div className="site-inner">
          <p className="kicker reveal">{t.deskKicker}</p>
          <h2 className="reveal">{t.deskH2}</h2>
          <p className="section-lead reveal">{t.deskLead}</p>
          <div className="desk-grid">
            {t.desk.map((d) => (
              <div className="desk-card reveal" key={d.id}>
                <DeskPicture
                  id={d.id}
                  alt={d.alt}
                  lang={lang}
                  theme={theme}
                  hours={t.deskHours}
                />
                <h3>
                  {d.title}
                  <span className="en">{d.sub}</span>
                </h3>
                <p>{d.body}</p>
              </div>
            ))}
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
              {/* v0.1.6 — the first Linux release (an x64 AppImage). */}
              <a
                className="cta-dl"
                href={DOWNLOAD_URL}
                target="_blank"
                rel="noreferrer"
              >
                <DownloadIcon />
                {t.dlBtnLinux}
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
            </a>
            {/* No-break before the dot: it stays at the end of the first line. */}
            {" · "}
            {/* One unit: on a phone it moves to its own line whole instead
                of breaking mid-word (本页演|示) under the balanced wrap. */}
            <span className="site-footer__note">{t.footer}</span>
          </p>
          <p className="site-footer__fan">{t.fanNotice}</p>
        </div>
      </footer>
    </div>
  );
}
