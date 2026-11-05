import hertaMark from "../../assets/herta-flow-avatar.png";
import type { TFn } from "../../i18n/LocaleProvider.js";
import {
  TRAILBLAZER_AVATARS,
  useTrailblazerAvatar,
} from "../../lib/trailblazer-avatar.js";

/**
 * Who steered 板砖 (ADR 0085 amendment 2026-11-04): an 18 px avatar ringed in
 * the speaker's colour — the Trailblazer gold, Herta violet — in place of a
 * 插话 label. Herta's is her Flow mark (ADR 0084); the Trailblazer's is the
 * one they picked in Settings → Window (`lib/trailblazer-avatar.ts`).
 *
 * Takes the caller's translator: the rows it sits in follow the session's
 * language, not the app's (ADR 0019).
 */
export function SpeakerAvatar(props: {
  readonly speaker: "trailblazer" | "herta";
  readonly t: TFn;
}): JSX.Element {
  const avatar = useTrailblazerAvatar();
  const name = props.t(
    props.speaker === "herta" ? "run.speaker.herta" : "run.speaker.trailblazer",
  );
  return (
    <span
      className={`speaker-avatar is-${props.speaker}`}
      role="img"
      aria-label={name}
    >
      <img
        src={
          props.speaker === "herta" ? hertaMark : TRAILBLAZER_AVATARS[avatar]
        }
        alt=""
        draggable={false}
      />
    </span>
  );
}
