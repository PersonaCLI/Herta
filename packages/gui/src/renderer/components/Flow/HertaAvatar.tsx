import avatar from "../../assets/herta-flow-avatar.png";

/**
 * Herta's mark beside her word in Flow (ADR 0084 §3): the chibi head from the
 * owner's reference (2026-10-30, a phone case's print), cut from the
 * high-resolution version the owner made of it: brim, bangs, both eyes and the
 * smile, 192 px. Drawn versions did not read as her. Decorative: her name is
 * written beside it.
 */
export function HertaAvatar(props: {
  readonly className?: string;
}): JSX.Element {
  return (
    <img
      className={props.className}
      src={avatar}
      alt=""
      aria-hidden="true"
      draggable={false}
    />
  );
}
