/**
 * The composer's staged pictures (ADR 0048 §4): each one's thumbnail, which
 * opens it large, and its ×, which takes it back as if it never arrived.
 * Split out of Composer.tsx (review 2026-11-10, moved 2026-11-27); the
 * composer decides when the strip shows.
 */
import { attachmentImageUrl } from "../../../shared/attachment-image.js";
import type { useT } from "../../i18n/LocaleProvider.js";
import type { useLightbox } from "./ImageLightbox.js";
import type { StagedImagesState } from "./useStagedImages.js";

export function ComposerStaged(props: {
  readonly images: StagedImagesState;
  readonly openLightbox: ReturnType<typeof useLightbox>;
  readonly t: ReturnType<typeof useT>;
}): JSX.Element {
  const { images, openLightbox, t } = props;
  return (
    <ul className="composer-staged" aria-label={t("composer.staged")}>
      {images.staged.map((img) => (
        <li className="composer-staged__item" key={img.id}>
          {/* Click-to-enlarge (ADR 0048 §4a): checking WHICH screenshot
              this is before sending is exactly when it matters — the ×
              is the take-back, this is the look. */}
          <button
            type="button"
            className="composer-staged__open"
            aria-label={`${t("lightbox.open")} ${img.name}`}
            onClick={() => openLightbox(img)}
          >
            <img
              className="composer-staged__thumb"
              src={attachmentImageUrl(img.path)}
              alt={img.name}
              title={img.name}
              draggable={false}
            />
          </button>
          <button
            type="button"
            className="composer-staged__remove"
            aria-label={`${t("composer.staged.remove")} ${img.name}`}
            onClick={() => images.unstage(img.id)}
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
