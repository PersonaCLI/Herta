<div align="center">

<img src="packages/gui/build/icon.png" width="120" alt="Herta" />

# Herta · 黑塔

**给自我以模型，而不是给模型以自我。**<br/>
*Give the model to a self — not a self to the model.*

[**Website & live demo**](https://www.herta-ai.com/) ·
[**Download**](https://github.com/PersonaCLI/Herta/releases) ·
[**Philosophy**](./PHILOSOPHY.md)

![license](https://img.shields.io/badge/license-MIT%20(code)-blue)
![platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-0078d4)
![self](https://img.shields.io/badge/self-DeepSeek%20completion-4d6bfe)

</div>

黑塔 (Herta) is the self that uses the agent — not a coding agent wearing her
face. You talk with her through a shared terminal record; when code needs
changing, she hands the work to a silent coding coprocessor (she calls it
板砖) and supervises it alongside you.
Turn on dreaming, and while you are away she looks back over finished
sessions and keeps what is worth remembering in her first-person
autobiography. Her memories fade, grow firmer when they come up again, and
are forgotten selectively, like a person's.

<img src="website/src/assets/demo-poster.png" alt="Herta desktop app — a @板砖 commission: activity lines, test results, and her verdict in one shared record" />

<p align="center"><sub>A commission in progress: her dispatch to <b>@板砖</b>, the coprocessor's activity line (完成 · 测试 89/89), and her own verdict — all in the same record you read.</sub></p>

## What makes it different

- **Narrative completion.** Chat formats split a conversation into system,
  user and assistant roles, and that split keeps telling the model it is
  playing a part. Herta does not use that format: the model is given her own
  terminal record (DeepSeek completion mode) and asked to continue it as the
  same speaker. Her persona comes from that continuity.
- **Self–agent split.** People read and understand at a limited pace, and an
  agent produces far more detail than that. So the coding agent does not talk
  to you: it leaves short steps in the shared record, and Herta reviews them
  and tells you what they mean. Its report has no summary for her to recite,
  and she does not pre-digest tasks for it.
- **Gated dream memory.** Memory that lasts across sessions goes through a
  filter: is it worth keeping; once written, is it already remembered; and
  does it keep her voice and stay faithful to what happened. Kept memories
  decay on a half-life under a fixed capacity, and when one is forgotten,
  what it knew about you goes into her autobiography first. Forgetting is
  deliberate: with limited room, memory has to choose.
- **Deterministic safety.** Permissions, path guards, command policy, and diff
  preview are harness code. The persona never decides what is allowed.

## One turn · 一次回合

You talk with Herta in the terminal. When code needs changing, she writes
`@板砖` in her line. Every step the coprocessor takes goes into the same
terminal record, where you and Herta can both see it, and she gives the
conclusion at the end.

<img src=".github/readme-assets/turn-flow.svg" alt="One turn: user, Herta, and the coprocessor collaborate around a single terminal record" />

## She dreams, therefore she remembers · 入梦

Dreaming is off by default; turn it on in Settings. It uses your DeepSeek API
quota. Once it is on, she looks back over finished sessions while you are
away. A moment worth keeping has to pass several checks — is it worth
remembering, is it already remembered, does it read like her — and what
passes comes with her into every later conversation. When memory fills, the
faintest of a group of similar memories makes way, and what it knew about
you is first written into her chapter on you.

<img src=".github/readme-assets/dream-cycle.svg" alt="The dream cycle: triggered while you are away, several checks, the live shelf, what a forgotten memory knew about you settling into her autobiography" />

## Her autobiography · 她的自传

Her prompt is a first-person text she keeps writing, in four parts: identity,
memories, world, and the present. It is written on three timescales, and it
never resets.

<img src=".github/readme-assets/vision-autobiography.svg" alt="Her first-person autobiography: who I am, what I remember, my world, my present — written on three timescales" />

## Repository layout

| Package | What it is |
| --- | --- |
| `packages/gui` | Electron desktop app (the primary product) |
| `packages/cli` | Terminal REPL |
| `packages/app-server` | Session host: turns, dream trigger, voice, approvals |
| `packages/herta` | The self: narrative completion, prompts, recap, bridge |
| `packages/core` | Silent coding backend runtime, tools loop, permissions |
| `packages/tools` | The backend's file/search/command tool set |
| `packages/knowledge` | Dream pipeline, canon knowledge store, voice work |
| `packages/memory` | Project memory |
| `packages/providers` | DeepSeek providers (completion + chat) |
| `website` | The intro site — its demo runs the app's real renderer |

## Install

Installers are on the [releases page](https://github.com/PersonaCLI/Herta/releases):

- **Windows 10/11 (x64)** — `Herta-Setup-<version>.exe`. The installer is not
  code-signed, so SmartScreen warns on first run: More info → Run anyway.
- **macOS 12+** — `Herta-<version>-arm64.dmg` (Apple Silicon) or
  `Herta-<version>-x64.dmg` (Intel). Signed and notarized.
- **Linux (x64)** — `Herta-x86_64.AppImage`, from v0.1.6. Run
  `chmod +x Herta-x86_64.AppImage` once, then start it; later versions update
  in the app. It needs no separate libfuse2. On distributions that restrict
  unprivileged user namespaces (Ubuntu 24.04's default, for example), it runs
  with Chromium's sandbox turned off. Without a keyring (gnome-keyring or
  KWallet), the API key is kept in an owner-only file rather than encrypted.
- **Arch Linux (x64)** — `herta-bin` on the
  [AUR](https://aur.archlinux.org/packages/herta-bin) repacks that AppImage
  (`paru -S herta-bin` or `yay -S herta-bin`). It installs the application
  payload only and runs on Arch's `electron43`, so it takes about 67 MiB
  instead of 334 MiB, and Electron security updates arrive through pacman.
  Because it repacks the release rather than the repository, her voice clips
  come with it — a source build is silent. Arch users can also build from
  source with [`packaging/arch/PKGBUILD`](./packaging/arch/PKGBUILD).

## Build

Requirements: Node 22 LTS (`.node-version` / `mise.toml`, read by nvm, asdf,
fnm and mise) with corepack (pnpm 9). Node 26 and newer cannot install this
workspace: `better-sqlite3` 11.x ships no prebuilt binary for that ABI and its
C++ does not compile against Node 26's V8, so `pnpm install` dies in node-gyp.

```sh
pnpm install
pnpm build          # compile all packages
pnpm test           # full test suite
pnpm --filter @herta/gui dev    # run the desktop app in dev mode
pnpm --filter @herta/gui dist   # package the Windows installer
pnpm --filter @herta/gui dist:mac # package the macOS app (run on macOS)
pnpm --filter @herta/gui dist:linux # package the Linux AppImage (run on Linux)
pnpm --filter @herta/website dev # run the website locally
```

At runtime the app needs a DeepSeek API key, configured in-app on first run
and stored on your machine — encrypted by the OS keychain when one is
available. Your conversation goes to the DeepSeek API and nowhere else,
except that with cloud voice turned on, her lines also go to MiniMax.

Behind a corporate proxy: the desktop app needs no configuration — it uses
Chromium's network stack, so it picks up your system proxy settings and your
OS certificate store. The CLI runs on Node, which does neither; set
`NODE_USE_ENV_PROXY=1` along with `HTTPS_PROXY`, and `NODE_EXTRA_CA_CERTS` if
your proxy re-signs TLS.

### Voice assets

Her voice clips live in `data/voice/`, which is **not distributed in this
repository**. The app builds and runs without them (silent); official
installer releases on the [releases page](https://github.com/PersonaCLI/Herta/releases)
include them.

One clip is the exception and does ship here:
`website/src/assets/opening-voice.opus`, which the website demo paces its
opening reveal to. Like every other game-derived asset it is fan content and
sits outside the MIT grant — see the exclusion list in [LICENSE](./LICENSE).

## Philosophy

The design intent — why a self rather than a role, why memory must forget,
why the persona may never own safety — is written down in
[PHILOSOPHY.md](./PHILOSOPHY.md). It is the most useful document in this
repository.

## License

Code is [MIT](./LICENSE). Third-party libraries compiled into the installers
(pdf.js, React, and the rest) keep their own licenses, reproduced in
[THIRD-PARTY-NOTICES.md](./THIRD-PARTY-NOTICES.md) — generated from the
actual bundle at build time, so it lists exactly what ships.

Herta is a character from *Honkai: Star Rail*, © HoYoverse. This is an
unofficial fan project, unaffiliated with and not endorsed by HoYoverse.
Game-derived materials (character art, voice audio, canon text) are fan
content under HoYoverse's fan-creation terms and are **not** covered by the
MIT license.
