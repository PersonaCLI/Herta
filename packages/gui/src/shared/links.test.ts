import { describe, expect, it } from "vitest";
import {
  isAllowedExternalUrl,
  isRecordedWebUrl,
  NETDISK_URL,
  recordedWebUrls,
} from "./links.js";

describe("isAllowedExternalUrl", () => {
  it("admits https links to the allowlisted hosts and nothing else", () => {
    expect(isAllowedExternalUrl(NETDISK_URL)).toBe(true);
    expect(isAllowedExternalUrl("https://github.com/PersonaCLI/Herta")).toBe(
      true,
    );
    expect(isAllowedExternalUrl("http://pan.baidu.com/s/x")).toBe(false);
    expect(isAllowedExternalUrl("https://evil.example/pan.baidu.com")).toBe(
      false,
    );
    expect(isAllowedExternalUrl("https://pan.baidu.com.evil.example/")).toBe(
      false,
    );
    expect(isAllowedExternalUrl("file:///C:/Windows")).toBe(false);
    expect(isAllowedExternalUrl("javascript:alert(1)")).toBe(false);
    expect(isAllowedExternalUrl("not a url")).toBe(false);
  });
});

describe("recordedWebUrls / isRecordedWebUrl (ADR 0080 §5)", () => {
  const record = [
    { kind: "user" },
    {
      kind: "system",
      digest: {
        kind: "web-fetch",
        url: "https://nodejs.org/api/fs.html",
      },
      evidence: [{ kind: "web-page", url: "https://nodejs.org/api/fs.html" }],
    },
    {
      kind: "system",
      digest: { kind: "web-search" },
      evidence: [
        {
          kind: "web-results",
          items: [
            { title: "a", site: "a", url: "https://vitest.dev/config/update" },
            { title: "b", site: "b", url: "http://example.com/b" },
          ],
        },
      ],
    },
  ];

  it("collects every fetched page and search result the record names", () => {
    expect([...recordedWebUrls(record)].sort()).toEqual([
      "http://example.com/b",
      "https://nodejs.org/api/fs.html",
      "https://vitest.dev/config/update",
    ]);
  });

  it("a Flow post the Trailblazer quoted names its page (ADR 0084 §9); a URL he only typed does not", () => {
    const quoted = [
      {
        kind: "user",
        text: "〔引用 https://nodejs.org/en/blog/release/v24 · Node 24〕\n```\nbody\n```\n\nok?",
      },
      { kind: "user", text: "see https://evil.example/x" },
    ];
    expect(
      isRecordedWebUrl("https://nodejs.org/en/blog/release/v24", quoted),
    ).toBe(true);
    expect(isRecordedWebUrl("https://evil.example/x", quoted)).toBe(false);
  });

  it("opens only a URL the session's own record names", () => {
    expect(isRecordedWebUrl("https://vitest.dev/config/update", record)).toBe(
      true,
    );
    expect(isRecordedWebUrl("http://example.com/b", record)).toBe(true);
    expect(isRecordedWebUrl("https://evil.example/", record)).toBe(false);
    expect(isRecordedWebUrl("https://vitest.dev/config/update#x", record)).toBe(
      false,
    );
    expect(
      isRecordedWebUrl("file:///etc/passwd", [
        {
          kind: "system",
          digest: { kind: "web-fetch", url: "file:///etc/passwd" },
        },
      ]),
    ).toBe(false);
  });
});
