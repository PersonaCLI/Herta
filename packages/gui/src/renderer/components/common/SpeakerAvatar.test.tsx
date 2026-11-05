import { act } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import hertaMark from "../../assets/herta-flow-avatar.png";
import { useT } from "../../i18n/LocaleProvider.js";
import { renderWithLocale } from "../../i18n/test-util.js";
import {
  resetTrailblazerAvatarForTest,
  setTrailblazerAvatar,
  TRAILBLAZER_AVATARS,
} from "../../lib/trailblazer-avatar.js";
import { SpeakerAvatar } from "./SpeakerAvatar.js";

function Avatars(): JSX.Element {
  const t = useT();
  return (
    <>
      <SpeakerAvatar speaker="trailblazer" t={t} />
      <SpeakerAvatar speaker="herta" t={t} />
    </>
  );
}

const src = (container: HTMLElement, speaker: string): string | null =>
  container
    .querySelector(`.speaker-avatar.is-${speaker} img`)
    ?.getAttribute("src") ?? null;

afterEach(resetTrailblazerAvatarForTest);

describe("SpeakerAvatar — each speaker's drawn mark (ADR 0085 amendment 2026-11-05)", () => {
  it("draws the male mark before a pick, and Herta's Flow mark", () => {
    const { container } = renderWithLocale(<Avatars />);
    expect(src(container, "trailblazer")).toBe(TRAILBLAZER_AVATARS.male);
    expect(src(container, "herta")).toBe(hertaMark);
  });

  it("the Trailblazer's follows the pick at once, and Herta's does not", () => {
    const { container } = renderWithLocale(<Avatars />);
    act(() => setTrailblazerAvatar("female"));
    expect(src(container, "trailblazer")).toBe(TRAILBLAZER_AVATARS.female);
    expect(src(container, "herta")).toBe(hertaMark);
  });

  it("the pick survives a reload, and a value that is not an avatar reads as no pick", () => {
    setTrailblazerAvatar("female");
    expect(localStorage.getItem("herta.trailblazer.avatar")).toBe("female");
    localStorage.setItem("herta.trailblazer.avatar", "nonsense");
    resetTrailblazerAvatarForTest();
    const { container } = renderWithLocale(<Avatars />);
    expect(src(container, "trailblazer")).toBe(TRAILBLAZER_AVATARS.male);
  });
});
