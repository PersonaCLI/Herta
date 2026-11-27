/**
 * The two cards that sit above the composer in the held message's place:
 * 继续, which continues 板砖's interrupted run (ADR 0071 §1.4), and the
 * held message itself (ADR 0063). Split out of Composer.tsx (review
 * 2026-11-10, moved 2026-11-27); the composer decides when each shows.
 */
import type { RefObject } from "react";
import type { useT } from "../../i18n/LocaleProvider.js";
import { quotedMessagePreview } from "../../lib/quote-format.js";
import type { SessionStore } from "../../store/session-store.js";

/** 继续: the interrupted run can be continued. */
export function ComposerResumeCard(props: {
  readonly t: ReturnType<typeof useT>;
  readonly sessionStore: SessionStore;
}): JSX.Element {
  const { t, sessionStore } = props;
  return (
    <section
      className="composer-held composer-resume"
      aria-label={t("composer.resume.aria")}
      data-testid="composer-resume"
    >
      <span className="composer-held__icon" aria-hidden="true">
        <svg
          viewBox="0 0 14 14"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <circle cx="7" cy="7" r="5.6" />
          <path d="M5.6 4.6v4.8M8.4 4.6v4.8" />
        </svg>
      </span>
      <span className="composer-held__text">{t("composer.resume.text")}</span>
      <span className="composer-held__actions">
        <button
          type="button"
          className="composer-held__action composer-held__action--steer"
          onClick={() => void sessionStore.continueInterrupted()}
        >
          <svg
            viewBox="0 0 11 11"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M3 2l5.5 3.5L3 9z" />
          </svg>
          {t("composer.resume.action")}
        </button>
      </span>
    </section>
  );
}

/** The held message, with its answers: steer it into the run, take it
 *  back to edit, or discard it. */
export function ComposerHeldCard(props: {
  /** The card's node: the flying clone lifts off from its rect. */
  readonly heldCardRef: RefObject<HTMLElement>;
  readonly suppressed: boolean;
  readonly t: ReturnType<typeof useT>;
  readonly held: string;
  readonly canSteer: boolean;
  readonly onSteer: () => void;
  readonly onEditHeld: () => void;
  readonly sessionStore: SessionStore;
}): JSX.Element {
  const {
    heldCardRef,
    suppressed,
    t,
    held,
    canSteer,
    onSteer,
    onEditHeld,
    sessionStore,
  } = props;
  return (
    <section
      ref={heldCardRef}
      className={`composer-held${suppressed ? " is-suppressed" : ""}`}
      aria-label={t("composer.hold.aria")}
      title={t("composer.hold.label")}
      data-testid="composer-held"
    >
      <span className="composer-held__icon" aria-hidden="true">
        <svg
          viewBox="0 0 14 14"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <circle cx="7" cy="7" r="5.6" />
          <path d="M7 4.2V7l1.9 1.4" />
        </svg>
      </span>
      <span className="composer-held__text">{quotedMessagePreview(held)}</span>
      <span className="composer-held__actions">
        {canSteer && (
          <button
            type="button"
            className="composer-held__action composer-held__action--steer"
            onClick={onSteer}
          >
            <svg
              viewBox="0 0 11 11"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M1.5 5.5h8M6 2l3.5 3.5L6 9" />
            </svg>
            {t("composer.hold.steer")}
          </button>
        )}
        <button
          type="button"
          className="composer-held__action"
          onClick={onEditHeld}
        >
          {t("composer.hold.edit")}
        </button>
        <button
          type="button"
          className="composer-held__action composer-held__action--discard"
          aria-label={t("composer.hold.discard")}
          title={t("composer.hold.discard")}
          onClick={() => sessionStore.clearHeld()}
        >
          <svg
            viewBox="0 0 10 10"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            aria-hidden="true"
          >
            <path d="M2.5 2.5l5 5M7.5 2.5l-5 5" />
          </svg>
        </button>
      </span>
    </section>
  );
}
