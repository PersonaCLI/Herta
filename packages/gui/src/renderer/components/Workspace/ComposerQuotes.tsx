/**
 * The row above the composer's input: the 插话 tag while what is sent goes
 * to 板砖's run as a steer (ADR 0085 §9), and the quotes staged from the
 * viewer's page (ADR 0078 §6). Split out of Composer.tsx (review
 * 2026-11-10, moved 2026-11-27); the composer decides when the row shows.
 */

import type { useT } from "../../i18n/LocaleProvider.js";
import { type ComposerQuote, chipLabel } from "../../lib/quote-format.js";
import type { SessionStore } from "../../store/session-store.js";

export function ComposerQuotes(props: {
  readonly steerOn: boolean;
  readonly composerQuotes: readonly ComposerQuote[];
  readonly lang: "zh" | "en";
  readonly t: ReturnType<typeof useT>;
  readonly sessionStore: SessionStore;
}): JSX.Element {
  const { steerOn, composerQuotes, lang, t, sessionStore } = props;
  return (
    <ul className="composer-quotes">
      {steerOn && (
        <li className="composer-quote composer-steer-tag">
          <span className="composer-quote__label">
            {t("composer.steer.tag")}
          </span>
          <button
            type="button"
            className="composer-quote__remove"
            aria-label={t("composer.steer.off")}
            onClick={() => sessionStore.setComposerSteer(false)}
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
        </li>
      )}
      {composerQuotes.map((q) => (
        <li className="composer-quote" key={q.id}>
          <svg
            className="composer-quote__icon"
            viewBox="0 0 13 13"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M3 9.5c-.3-1.8.3-3.4 2-4.2M7.5 9.5c-.3-1.8.3-3.4 2-4.2" />
          </svg>
          <span className="composer-quote__label">{chipLabel(q, lang)}</span>
          <span className="composer-quote__preview">
            {q.title ??
              q.text.split("\n").find((l) => l.trim().length > 0) ??
              ""}
          </span>
          <button
            type="button"
            className="composer-quote__remove"
            aria-label={`${t("composer.quote.remove")} ${chipLabel(q, lang)}`}
            onClick={() => sessionStore.removeComposerQuote(q.id)}
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
        </li>
      ))}
    </ul>
  );
}
