import { useT } from "../../i18n/LocaleProvider.js";
import {
  setTrailblazerAvatar,
  TRAILBLAZER_AVATARS,
  type TrailblazerAvatar,
  useTrailblazerAvatar,
} from "../../lib/trailblazer-avatar.js";

/**
 * Settings → Window: the Trailblazer picks one of their two avatars (ADR 0085
 * amendment 2026-11-05). Radio inputs over the pictures, so the arrow keys
 * and a screen reader treat it as any choice of one. Applies at once.
 */
export function AvatarPicker(): JSX.Element {
  const t = useT();
  const picked = useTrailblazerAvatar();
  const options: readonly {
    readonly value: TrailblazerAvatar;
    readonly label: string;
  }[] = [
    { value: "male", label: t("window.avatarMale") },
    { value: "female", label: t("window.avatarFemale") },
  ];
  return (
    <div
      className="avatar-picker"
      role="radiogroup"
      aria-label={t("window.avatar")}
    >
      {options.map((o) => (
        <label key={o.value} className="avatar-picker__option">
          <input
            type="radio"
            name="trailblazer-avatar"
            checked={picked === o.value}
            aria-label={o.label}
            onChange={() => setTrailblazerAvatar(o.value)}
          />
          <img src={TRAILBLAZER_AVATARS[o.value]} alt="" draggable={false} />
        </label>
      ))}
    </div>
  );
}
