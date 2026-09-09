import { describe, expect, it } from "vitest";
import { isAllowedExternalUrl, NETDISK_URL } from "./links.js";

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
