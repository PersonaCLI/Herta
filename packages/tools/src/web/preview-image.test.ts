import { describe, expect, it } from "vitest";
import {
  fetchPreviewImage,
  type PreviewGet,
  type PreviewLookup,
  previewImageUrl,
  publicAddress,
} from "./preview-image.js";

/** A Flow post's preview picture, fetched behind its guard (ADR 0084 §8). */

const PUBLIC = "93.184.216.34";
const lookupAll =
  (table: Record<string, string[]>): PreviewLookup =>
  async (host) =>
    (table[host] ?? []).map((address) => ({
      address,
      family: address.includes(":") ? 6 : 4,
    }));

/** A web of pages: URL → status, headers, body. Records each GET. */
function web(
  pages: Record<
    string,
    {
      status?: number;
      headers?: Record<string, string>;
      body?: string | Uint8Array;
    }
  >,
) {
  const got: { url: string; address: string }[] = [];
  const get: PreviewGet = async (url, address) => {
    got.push({ url: url.toString(), address: address.address });
    const page = pages[url.toString()];
    if (page === undefined)
      return {
        status: 404,
        headers: {},
        body: (async function* () {})(),
        close: () => {},
      };
    const bytes =
      typeof page.body === "string"
        ? new TextEncoder().encode(page.body)
        : (page.body ?? new Uint8Array());
    return {
      status: page.status ?? 200,
      headers: page.headers ?? {},
      body: (async function* () {
        for (let i = 0; i < bytes.length; i += 4096)
          yield bytes.slice(i, i + 4096);
      })(),
      close: () => {},
    };
  };
  return { get, got };
}

const HEAD = (meta: string) =>
  `<html><head><title>x</title>${meta}</head><body>${"z".repeat(10)}</body></html>`;
const PNG = new Uint8Array([137, 80, 78, 71, 1, 2, 3]);
const signal = () => new AbortController().signal;

describe("the addresses it will reach", () => {
  it("only public ones", () => {
    for (const ip of [
      "127.0.0.1",
      "10.1.2.3",
      "172.16.0.1",
      "192.168.1.1",
      "169.254.169.254",
      "100.64.0.1",
      "0.0.0.0",
      "224.0.0.1",
      "::1",
      "fd00::1",
      "fe80::1",
      "::ffff:127.0.0.1",
    ])
      expect(publicAddress(ip), ip).toBe(false);
    for (const ip of [PUBLIC, "198.18.0.108", "8.8.8.8", "2606:4700::1111"])
      expect(publicAddress(ip), ip).toBe(true);
  });

  it("refuses http, a local host, and a name that resolves inward", async () => {
    const { get, got } = web({});
    const lookup = lookupAll({
      "inward.example": ["10.0.0.5"],
      "mixed.example": [PUBLIC, "127.0.0.1"],
    });
    expect(
      await fetchPreviewImage("http://news.example/a", signal(), {
        get,
        lookup,
      }),
    ).toEqual({ ok: false, why: "address" });
    expect(
      await fetchPreviewImage("https://localhost/a", signal(), { get, lookup }),
    ).toEqual({ ok: false, why: "address" });
    expect(
      await fetchPreviewImage("https://inward.example/a", signal(), {
        get,
        lookup,
      }),
    ).toEqual({ ok: false, why: "not_public" });
    expect(
      await fetchPreviewImage("https://mixed.example/a", signal(), {
        get,
        lookup,
      }),
    ).toEqual({ ok: false, why: "not_public" });
    expect(got).toEqual([]);
  });

  it("connects to the address it checked", async () => {
    const { get, got } = web({
      "https://news.example/a": {
        headers: { "content-type": "text/html" },
        body: HEAD('<meta property="og:image" content="/p.png">'),
      },
      "https://news.example/p.png": {
        headers: { "content-type": "image/png" },
        body: PNG,
      },
    });
    const r = await fetchPreviewImage("https://news.example/a", signal(), {
      get,
      lookup: lookupAll({ "news.example": [PUBLIC] }),
    });
    expect(r).toEqual({ ok: true, bytes: PNG, type: "image/png" });
    expect(got.map((g) => g.address)).toEqual([PUBLIC, PUBLIC]);
  });
});

describe("redirects", () => {
  it("are followed by hand, each hop checked again", async () => {
    const lookup = lookupAll({
      "a.example": [PUBLIC],
      "b.example": [PUBLIC],
      "inner.example": ["192.168.0.2"],
    });
    const ok = web({
      "https://a.example/x": {
        status: 301,
        headers: { location: "https://b.example/y" },
      },
      "https://b.example/y": {
        headers: { "content-type": "text/html" },
        body: HEAD(
          '<meta name="twitter:image" content="https://b.example/i.png">',
        ),
      },
      "https://b.example/i.png": {
        headers: { "content-type": "image/png" },
        body: PNG,
      },
    });
    expect(
      (
        await fetchPreviewImage("https://a.example/x", signal(), {
          get: ok.get,
          lookup,
        })
      ).ok,
    ).toBe(true);
    const inward = web({
      "https://a.example/x": {
        status: 302,
        headers: { location: "https://inner.example/admin" },
      },
    });
    expect(
      await fetchPreviewImage("https://a.example/x", signal(), {
        get: inward.get,
        lookup,
      }),
    ).toEqual({ ok: false, why: "not_public" });
    expect(inward.got.map((g) => g.url)).toEqual(["https://a.example/x"]);
  });

  it("at most three", async () => {
    const pages: Record<
      string,
      { status: number; headers: Record<string, string> }
    > = {};
    for (let i = 0; i < 5; i++)
      pages[`https://a.example/${i}`] = {
        status: 302,
        headers: { location: `https://a.example/${i + 1}` },
      };
    const { get } = web(pages);
    expect(
      await fetchPreviewImage("https://a.example/0", signal(), {
        get,
        lookup: lookupAll({ "a.example": [PUBLIC] }),
      }),
    ).toEqual({ ok: false, why: "redirects" });
  });
});

describe("the picture", () => {
  const lookup = lookupAll({ "n.example": [PUBLIC], "cdn.example": [PUBLIC] });
  const page = (img: Record<string, string>, body: Uint8Array = PNG) =>
    web({
      "https://n.example/a": {
        headers: { "content-type": "text/html" },
        body: HEAD(
          '<meta content="https://cdn.example/p" property="og:image">',
        ),
      },
      "https://cdn.example/p": { headers: img, body },
    });

  it("only an allowed image type, at most 2 MB", async () => {
    expect(
      await fetchPreviewImage("https://n.example/a", signal(), {
        get: page({ "content-type": "image/svg+xml" }).get,
        lookup,
      }),
    ).toEqual({ ok: false, why: "type" });
    expect(
      await fetchPreviewImage("https://n.example/a", signal(), {
        get: page({
          "content-type": "image/jpeg",
          "content-length": String(3 * 1024 * 1024),
        }).get,
        lookup,
      }),
    ).toEqual({ ok: false, why: "too_large" });
    const big = new Uint8Array(2 * 1024 * 1024 + 1);
    expect(
      await fetchPreviewImage("https://n.example/a", signal(), {
        get: page({ "content-type": "image/webp" }, big).get,
        lookup,
      }),
    ).toEqual({ ok: false, why: "too_large" });
  });

  it("a page with no preview tag has none", async () => {
    const { get } = web({
      "https://n.example/a": {
        headers: { "content-type": "text/html" },
        body: HEAD(""),
      },
    });
    expect(
      await fetchPreviewImage("https://n.example/a", signal(), { get, lookup }),
    ).toEqual({ ok: false, why: "no_image" });
  });

  it("the head only: a tag in the body is never read", () => {
    const page = new URL("https://n.example/a");
    expect(
      previewImageUrl('<meta property="og:image" content="p.jpg">', page),
    ).toBe("https://n.example/p.jpg");
    expect(
      previewImageUrl(
        '<meta property="og:image:secure_url" content="https://c.example/s.jpg"><meta property="og:image" content="o.jpg">',
        page,
      ),
    ).toBe("https://c.example/s.jpg");
    expect(
      previewImageUrl('<meta name="twitter:image" content="t.png">', page),
    ).toBe("https://n.example/t.png");
    expect(
      previewImageUrl('<meta property="og:title" content="x">', page),
    ).toBeNull();
  });

  it("a page that never answers runs out of time", async () => {
    const hanging: PreviewGet = (_u, _a, _accept, s) =>
      new Promise((_, reject) =>
        s.addEventListener("abort", () => reject(new Error("aborted"))),
      );
    expect(
      await fetchPreviewImage("https://n.example/a", signal(), {
        get: hanging,
        lookup,
        deadlineMs: 20,
      }),
    ).toEqual({ ok: false, why: "timeout" });
  });
});
