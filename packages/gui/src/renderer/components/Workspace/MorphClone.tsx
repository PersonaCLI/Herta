import { forwardRef, type RefObject } from "react";
import { createPortal } from "react-dom";
import { attachmentImageUrl } from "../../../shared/attachment-image.js";
import { renderBanzhuanText } from "../../lib/banzhuan-text.js";
import { type MessagePick, renderMentionText } from "../../lib/mention-text.js";
import { UserBubbleBody, type UserImageView } from "./UserBubble.js";

export interface MorphCloneProps {
  readonly overlay: RefObject<HTMLDivElement>;
  readonly variant: "user" | "herta";
  readonly text: string;
  /** Conversation language, for the 板砖→Brick display alias — the flying
   *  bubble must read exactly like the settled bubble it morphs into. */
  readonly lang: "zh" | "en";
  readonly widthPx?: number;
  /** Pictures riding this message (ADR 0048 §4): drawn ABOVE the bubble,
   *  absolutely positioned off its top edge so the flight geometry — which
   *  aims the bubble at its measured slot — is untouched. Mirrors the
   *  landed row's `.message-images` (same thumb class, same 6px gap), so
   *  the settle swap is seamless. */
  readonly images?: readonly UserImageView[];
  /** Width of the landed row's strip: the clone's strip must WRAP exactly
   *  like the one it swaps for (a max-content strip laid three pictures in
   *  one oversized line while the row wrapped them into two). */
  readonly imagesWidthPx?: number;
  /** Mentioned paths, drawn as chips like the row it lands on. */
  readonly mentions?: readonly string[];
  /** Picked page elements, drawn as chips like the row it lands on. */
  readonly picks?: readonly MessagePick[];
}

/** A floating bubble copy rendered into the workspace morph overlay,
 *  positioned/animated imperatively by the caller via the forwarded ref. */
export const MorphClone = forwardRef<HTMLDivElement, MorphCloneProps>(
  function MorphClone(props, ref): JSX.Element | null {
    if (props.overlay.current === null) return null;
    const bubbleClass =
      props.variant === "user" ? "user-bubble" : "herta-bubble";
    return createPortal(
      <div
        ref={ref}
        className={`message-bubble ${bubbleClass} morph-clone`}
        style={
          props.widthPx !== undefined
            ? { width: `${props.widthPx}px` }
            : undefined
        }
      >
        {props.images !== undefined && props.images.length > 0 && (
          <div
            className="message-images morph-clone-images"
            aria-hidden="true"
            style={
              props.imagesWidthPx !== undefined
                ? { width: `${props.imagesWidthPx}px` }
                : undefined
            }
          >
            {props.images.map((img) => (
              <img
                key={img.path}
                className="message-images__thumb"
                src={attachmentImageUrl(img.path)}
                alt=""
                // True pixel dimensions, same as the row it swaps for. The
                // fixed-size thumb CSS owns the box, so the clone cannot
                // grow mid-flight whether or not the bytes have loaded.
                {...(img.width !== undefined ? { width: img.width } : {})}
                {...(img.height !== undefined ? { height: img.height } : {})}
                draggable={false}
              />
            ))}
          </div>
        )}
        {props.variant === "user" ? (
          // The landed bubble's own body: its quotes as cards, not as the
          // header-and-fence text the message carries.
          <UserBubbleBody
            text={props.text}
            lang={props.lang}
            mentions={props.mentions}
            picks={props.picks}
            inert
          />
        ) : (
          <div className="message-text">
            {renderMentionText(
              props.text,
              props.mentions,
              (segment) => renderBanzhuanText(segment, "bubble", props.lang),
              undefined,
              props.picks !== undefined
                ? { list: props.picks, lang: props.lang }
                : undefined,
            )}
          </div>
        )}
      </div>,
      props.overlay.current,
    );
  },
);
