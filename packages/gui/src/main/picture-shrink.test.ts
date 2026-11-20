import { describe, expect, it, vi } from "vitest";

const decoded = vi.hoisted(() => ({
  empty: false,
  width: 4032,
  height: 3024,
  resizedTo: null as { width: number; height: number } | null,
}));
vi.mock("electron", () => ({
  nativeImage: {
    createFromBuffer: () => ({
      isEmpty: () => decoded.empty,
      getSize: () => ({ width: decoded.width, height: decoded.height }),
      resize: (size: { width: number; height: number }) => {
        decoded.resizedTo = { width: size.width, height: size.height };
        return { toJPEG: () => Buffer.from("resized-jpeg") };
      },
      toJPEG: () => Buffer.from("same-size-jpeg"),
    }),
  },
}));

const { PICTURE_LONG_EDGE, shrinkPictureWithNativeImage, shrunkSize } =
  await import("./picture-shrink.js");

describe("the desktop's picture shrinker (ADR 0048 amendment 2026-11-20)", () => {
  it("scales the long edge to 2048, the ratio kept; a picture already that small keeps its size", () => {
    expect(shrunkSize(4032, 3024)).toEqual({ width: 2048, height: 1536 });
    expect(shrunkSize(3024, 4032)).toEqual({ width: 1536, height: 2048 });
    expect(shrunkSize(2048, 1000)).toBeNull();
    expect(shrunkSize(800, 600)).toBeNull();
    expect(PICTURE_LONG_EDGE).toBe(2048);
  });

  it("a large PNG or JPEG comes back as a shrunk JPEG", async () => {
    decoded.resizedTo = null;
    const out = await shrinkPictureWithNativeImage({
      bytes: Buffer.from("x"),
      mime: "image/png",
    });
    expect(out?.mime).toBe("image/jpeg");
    expect(out?.bytes.toString()).toBe("resized-jpeg");
    expect(decoded.resizedTo).toEqual({ width: 2048, height: 1536 });
  });

  it("another format, or a picture Electron cannot decode, goes as it is", async () => {
    for (const mime of ["image/gif", "image/webp", "image/bmp"]) {
      expect(
        await shrinkPictureWithNativeImage({ bytes: Buffer.from("x"), mime }),
      ).toBeNull();
    }
    decoded.empty = true;
    expect(
      await shrinkPictureWithNativeImage({
        bytes: Buffer.from("x"),
        mime: "image/jpeg",
      }),
    ).toBeNull();
    decoded.empty = false;
  });
});
