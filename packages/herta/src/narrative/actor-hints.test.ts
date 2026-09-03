import { describe, expect, it } from "vitest";
import {
  DEFAULT_ACTOR_HINTS,
  defaultActorHintsFor,
  loadActorHints,
  selectBeatHint,
} from "./actor-hints.js";
import { PROMPT_ASSETS, PROMPT_ASSETS_EN } from "./prompt-assets.generated.js";
import { actorHintTexts } from "./thought-hint.js";

describe("loadActorHints (compiled assets, M-prompts-1)", () => {
  it("resolves every hint from the compiled corpus (non-empty, trimmed)", () => {
    const hints = loadActorHints();
    for (const value of [
      hints.phase2Thought,
      hints.phase2Speech,
      ...hints.speechRetry,
      ...hints.thoughtRetry,
      hints.beatPatchPreview,
      hints.beatVerification,
      hints.beatToolFail,
      hints.supervisorVetoTemplate,
    ]) {
      expect(value.length).toBeGreaterThan(0);
      expect(value).toBe(value.trimEnd());
    }
  });

  it("is deterministic — same object shape on every call", () => {
    expect(loadActorHints()).toEqual(loadActorHints());
  });

  it("splices {{no_banzhuan}} into the beat hints (no placeholder survives)", () => {
    const hints = loadActorHints();
    const clause = PROMPT_ASSETS.hints.beat_no_banzhuan_clause?.trimEnd() ?? "";
    expect(clause.length).toBeGreaterThan(0);
    for (const beat of [
      hints.beatPatchPreview,
      hints.beatVerification,
      hints.beatToolFail,
    ]) {
      expect(beat).not.toContain("{{no_banzhuan}}");
      expect(beat).toContain(clause);
    }
  });

  it("keeps {{reason}} intact in the supervisor veto template (runtime substitution)", () => {
    expect(loadActorHints().supervisorVetoTemplate).toContain("{{reason}}");
  });

  it("matches the compiled source for a directly-mapped hint", () => {
    const hints = loadActorHints();
    expect(hints.phase2Speech).toBe(
      PROMPT_ASSETS.hints.phase2_speech?.trimEnd(),
    );
    expect(hints.speechRetry[1]).toBe(
      PROMPT_ASSETS.hints.speech_retry_2?.trimEnd(),
    );
  });
});

describe("loadActorHints — interaction language (slice 4)", () => {
  it('default equals explicit lang: "zh" (zh identity)', () => {
    expect(loadActorHints("zh")).toEqual(loadActorHints());
  });

  it('lang: "en" resolves every hint from the EN bundle', () => {
    const hints = loadActorHints("en");
    expect(hints.phase2Speech).toBe(
      PROMPT_ASSETS_EN.hints.phase2_speech?.trimEnd(),
    );
    expect(hints.speechRetry[1]).toBe(
      PROMPT_ASSETS_EN.hints.speech_retry_2?.trimEnd(),
    );
    expect(hints.supervisorVetoTemplate).toBe(
      PROMPT_ASSETS_EN.hints.supervisor_veto?.trimEnd(),
    );
    expect(hints.supervisorVetoTemplate).toContain("{{reason}}");
    // Distinct from the zh set.
    expect(hints.phase2Speech).not.toBe(loadActorHints().phase2Speech);
  });

  it('lang: "en" splices the EN {{no_banzhuan}} clause into the beat hints', () => {
    const hints = loadActorHints("en");
    const clause =
      PROMPT_ASSETS_EN.hints.beat_no_banzhuan_clause?.trimEnd() ?? "";
    expect(clause.length).toBeGreaterThan(0);
    for (const beat of [
      hints.beatPatchPreview,
      hints.beatVerification,
      hints.beatToolFail,
    ]) {
      expect(beat).not.toContain("{{no_banzhuan}}");
      expect(beat).toContain(clause);
    }
  });
});

describe("defaultActorHintsFor (slice 4)", () => {
  it('"zh" returns the exact DEFAULT_ACTOR_HINTS object (byte-identical)', () => {
    expect(defaultActorHintsFor("zh")).toBe(DEFAULT_ACTOR_HINTS);
    expect(defaultActorHintsFor()).toBe(DEFAULT_ACTOR_HINTS);
  });

  it('"en" mirrors actorHintTexts("en") plus an EN supervisor-veto template', () => {
    const en = defaultActorHintsFor("en");
    const t = actorHintTexts("en");
    expect(en.phase2Thought).toBe(t.phase2Thought);
    expect(en.phase2Speech).toBe(t.phase2Speech);
    expect(en.speechRetry).toEqual(t.speechRetry);
    expect(en.thoughtRetry).toEqual(t.thoughtRetry);
    expect(en.beatPatchPreview).toBe(t.beatPatchPreview);
    expect(en.beatVerification).toBe(t.beatVerification);
    expect(en.beatToolFail).toBe(t.beatToolFail);
    expect(en.supervisorVetoTemplate).toContain("{{reason}}");
    expect(en.supervisorVetoTemplate).not.toBe(
      DEFAULT_ACTOR_HINTS.supervisorVetoTemplate,
    );
  });
});

describe("selectBeatHint", () => {
  it("maps signatures to the matching hint, else phase2Speech", () => {
    const h = DEFAULT_ACTOR_HINTS;
    expect(selectBeatHint(h, "patch.preview:first")).toBe(h.beatPatchPreview);
    expect(selectBeatHint(h, "verification.finished")).toBe(h.beatVerification);
    expect(selectBeatHint(h, "tool.fail:write_new_file:EACCES")).toBe(
      h.beatToolFail,
    );
    expect(selectBeatHint(h, "something.else")).toBe(h.phase2Speech);
  });
});
