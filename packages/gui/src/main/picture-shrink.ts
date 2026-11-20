import type { PictureShrinker } from "@herta/tools";
import { nativeImage } from "electron";

/** The longest edge a picture is sent at (ADR 0048 amendment 2026-11-20).
 *  Measured on DeepSeek: a 4032×3024 photo and the same at 2048×1536 cost
 *  the same prompt tokens (1 029), so the service sees no more of the larger
 *  one, and its upload took 54 s against 5 s. Not lower: where the service's
 *  own limit lies was not measured. */
export const PICTURE_LONG_EDGE = 2048;

/** The JPEG quality a shrunk picture is encoded at. */
export const PICTURE_JPEG_QUALITY = 85;

/** The size a picture is scaled to: its long edge at most
 *  `PICTURE_LONG_EDGE`, the ratio kept; null when it is already small
 *  enough to keep its size. Exported for its test. */
export function shrunkSize(
  width: number,
  height: number,
): { readonly width: number; readonly height: number } | null {
  const long = Math.max(width, height);
  if (long <= PICTURE_LONG_EDGE || width <= 0 || height <= 0) return null;
  const scale = PICTURE_LONG_EDGE / long;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/**
 * The desktop's picture shrinker for view_image (ADR 0048 amendment
 * 2026-11-20): a PNG or JPEG is scaled to a 2048 long edge if it is longer
 * and sent as JPEG 85. Other formats, and anything Electron cannot decode,
 * go as they are (null).
 *
 * It runs on the main thread: `nativeImage` is synchronous, about 100–120 ms
 * for a 12-megapixel photo (measured), near 0.3 s at the 8 MB cap. That is
 * an exception the owner chose to ADR 0068's rule (amendment 2026-11-20):
 * only a view_image picture over 1 MB pays it, once, and it saves the run
 * the upload of megabytes on every later request.
 */
export const shrinkPictureWithNativeImage: PictureShrinker = async ({
  bytes,
  mime,
}) => {
  if (mime !== "image/png" && mime !== "image/jpeg") return null;
  const image = nativeImage.createFromBuffer(bytes);
  if (image.isEmpty()) return null;
  const { width, height } = image.getSize();
  const size = shrunkSize(width, height);
  const scaled =
    size === null ? image : image.resize({ ...size, quality: "best" });
  return {
    bytes: scaled.toJPEG(PICTURE_JPEG_QUALITY),
    mime: "image/jpeg",
  };
};
