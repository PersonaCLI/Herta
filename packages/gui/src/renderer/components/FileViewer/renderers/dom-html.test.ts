import { describe, expect, it } from "vitest";
import {
  leavesTheMachine,
  sanitizedFragment,
  setSanitizedHtml,
} from "./dom-html.js";

function rendered(html: string): HTMLElement {
  const host = document.createElement("div");
  setSanitizedHtml(host, html);
  return host;
}

describe("what an element loads (review 2026-11-10)", () => {
  it("an address that names another machine is taken off the element", () => {
    for (const address of [
      "//attacker.example/share/x.png",
      "\\\\attacker.example\\share\\x.png",
      "file://attacker.example/share/x.png",
      "file:////attacker.example/share/x.png",
      "FILE://ATTACKER/share/x.png",
      "  //attacker.example/share/x.png",
      "/\\attacker.example/share/x.png",
    ]) {
      expect(leavesTheMachine(address), address).toBe(true);
      const img = rendered(
        `<p><img src="${address}" alt="x"></p>`,
      ).querySelector("img");
      expect(img, address).not.toBeNull();
      expect(img?.getAttribute("src"), address).toBeNull();
      // The element stays, so the page says an image was meant.
      expect(img?.getAttribute("alt")).toBe("x");
    }
  });

  it("a file on this machine, and what is not a file at all, are not such an address", () => {
    for (const address of [
      "file:///C:/Users/dev/app/docs/diagram.png",
      "file:///home/dev/app/docs/diagram.png",
      "file://localhost/C:/docs/diagram.png",
      "docs/diagram.png",
      "./diagram.png",
      "/assets/diagram.png",
      "data:image/png;base64,iVBORw0KGgo=",
      "blob:null/3f9c2a71",
      "https://example.com/diagram.png",
      "herta-attachment://s1/a.png",
    ]) {
      expect(leavesTheMachine(address), address).toBe(false);
    }
  });

  it("what the sanitizer lets an image load is left as written", () => {
    // The library has its own list of schemes (`file:` is not on it); this
    // is what is left of it once the hook has run.
    for (const address of [
      "docs/diagram.png",
      "./diagram.png",
      "/assets/diagram.png",
      "data:image/png;base64,iVBORw0KGgo=",
      "https://example.com/diagram.png",
    ]) {
      const img = rendered(`<img src="${address}">`).querySelector("img");
      expect(img?.getAttribute("src"), address).toBe(address);
    }
  });

  it("every way an element loads is read: srcset, a poster, a source, a track", () => {
    const host = rendered(
      [
        '<img id="a" src="ok.png" srcset="ok.png 1x, //attacker.example/s/x.png 2x">',
        '<video id="b" src="file://attacker.example/s/v.mp4" poster="//attacker.example/s/p.png"></video>',
        '<audio id="c" src="\\\\attacker.example\\s\\a.mp3"></audio>',
        '<picture><source id="d" srcset="//attacker.example/s/x.webp"><img src="ok.png"></picture>',
        '<video><track id="e" src="//attacker.example/s/t.vtt"></video>',
      ].join(""),
    );
    expect(host.querySelector("#a")?.getAttribute("src")).toBe("ok.png");
    expect(host.querySelector("#a")?.getAttribute("srcset")).toBeNull();
    expect(host.querySelector("#b")?.getAttribute("src")).toBeNull();
    expect(host.querySelector("#b")?.getAttribute("poster")).toBeNull();
    expect(host.querySelector("#c")?.getAttribute("src")).toBeNull();
    expect(host.querySelector("#d")?.getAttribute("srcset")).toBeNull();
    expect(host.querySelector("#e")?.getAttribute("src")).toBeNull();
    expect(host.innerHTML).not.toContain("attacker.example");
  });

  it("a srcset of local files is kept whole", () => {
    const img = rendered(
      '<img src="a.png" srcset="a.png 1x, a@2x.png 2x">',
    ).querySelector("img");
    expect(img?.getAttribute("srcset")).toBe("a.png 1x, a@2x.png 2x");
  });
});

describe("no style from the page (review 2026-11-10)", () => {
  it("an inline style is dropped, with the address and the position it carried", () => {
    const host = rendered(
      [
        '<div id="a" style="background:url(//attacker.example/s/x.png)">a</div>',
        '<div id="b" style="position:fixed;inset:0;z-index:9999">b</div>',
        '<table id="c" background="//attacker.example/s/x.png"><tr><td background="file://attacker.example/s/y.png">c</td></tr></table>',
      ].join(""),
    );
    expect(host.querySelector("#a")?.getAttribute("style")).toBeNull();
    expect(host.querySelector("#b")?.getAttribute("style")).toBeNull();
    expect(host.querySelector("#c")?.getAttribute("background")).toBeNull();
    expect(host.querySelector("td")?.getAttribute("background")).toBeNull();
    expect(host.innerHTML).not.toContain("attacker.example");
    // The text is still the page's.
    expect(host.textContent).toBe("abc");
  });

  it("what the viewer itself styles by is kept: a class, an alignment, a size", () => {
    const frag = sanitizedFragment(
      '<pre><code class="language-ts"><span class="hljs-keyword">const</span></code></pre><table><tr><th align="center">h</th></tr></table><img src="a.png" width="200" alt="a">',
    );
    const host = document.createElement("div");
    host.append(frag);
    expect(host.querySelector("code")?.className).toBe("language-ts");
    expect(host.querySelector("span")?.className).toBe("hljs-keyword");
    expect(host.querySelector("th")?.getAttribute("align")).toBe("center");
    expect(host.querySelector("img")?.getAttribute("width")).toBe("200");
  });
});
