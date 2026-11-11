import { StringDecoder } from "node:string_decoder";
import { afterEach, describe, expect, it } from "vitest";
import {
  ConsoleDecoder,
  codePageLabel,
  consoleLegacyEncoding,
  decodeConsoleOutput,
  parseAcp,
  setConsoleLegacyEncodingForTest,
} from "./console-decode.js";

/** 「中文」 and 「系统找不到指定的文件。」 as a program on a Chinese Windows
 *  writes them to a pipe: code page 936. */
const GBK_ZHONGWEN = Buffer.from([0xd6, 0xd0, 0xce, 0xc4]);
const GBK_NOT_FOUND = Buffer.from([
  0xcf, 0xb5, 0xcd, 0xb3, 0xd5, 0xd2, 0xb2, 0xbb, 0xb5, 0xbd, 0xd6, 0xb8, 0xb6,
  0xa8, 0xb5, 0xc4, 0xce, 0xc4, 0xbc, 0xfe, 0xa1, 0xa3,
]);
const utf8 = (text: string): Buffer => Buffer.from(text, "utf8");
const NL = utf8("\n");

function all(decoder: ConsoleDecoder, chunks: Buffer[]): string {
  let out = "";
  for (const c of chunks) out += decoder.write(c);
  return out + decoder.end();
}

describe("a child's output in the machine's code page (review 2026-11-10)", () => {
  it("a line that is not UTF-8 is read in it, and the UTF-8 lines beside it as UTF-8", () => {
    const stream = Buffer.concat([
      utf8("node: 你好，世界\n"),
      GBK_NOT_FOUND,
      utf8("\r\n"),
      utf8("exit 1 — done\n"),
    ]);
    expect(all(new ConsoleDecoder("gb18030"), [stream])).toBe(
      "node: 你好，世界\n系统找不到指定的文件。\r\nexit 1 — done\n",
    );
    // What every byte read as UTF-8 gave: the line nobody could read.
    expect(stream.toString("utf8")).toContain("�");
  });

  it("a chunk that ends inside a character waits for the rest of its line", () => {
    const decoder = new ConsoleDecoder("gb18030");
    // Cut inside the second GBK character, then inside a UTF-8 one.
    expect(decoder.write(GBK_ZHONGWEN.subarray(0, 3))).toBe("");
    expect(decoder.write(Buffer.concat([GBK_ZHONGWEN.subarray(3), NL]))).toBe(
      "中文\n",
    );
    const hello = utf8("你好\n");
    expect(decoder.write(hello.subarray(0, 4))).toBe("");
    expect(decoder.write(hello.subarray(4))).toBe("你好\n");
    expect(decoder.end()).toBe("");
  });

  it("a carriage return ends a line too, so a progress line still moves", () => {
    const decoder = new ConsoleDecoder("gb18030");
    expect(decoder.write(utf8("10%\r"))).toBe("10%\r");
    expect(decoder.write(utf8("20%\r"))).toBe("20%\r");
    expect(decoder.write(utf8("done"))).toBe("");
    expect(decoder.end()).toBe("done");
  });

  it("what is left with no line break comes out at the end", () => {
    expect(all(new ConsoleDecoder("gb18030"), [GBK_ZHONGWEN])).toBe("中文");
    expect(all(new ConsoleDecoder("gb18030"), [utf8("no newline")])).toBe(
      "no newline",
    );
  });

  it("one long line is not held to its end, and is not cut inside a character", () => {
    const decoder = new ConsoleDecoder("gb18030");
    const line = utf8("好".repeat(30_000)); // 90 000 bytes, no line break
    let out = decoder.write(line.subarray(0, 70_000));
    expect(out.length).toBeGreaterThan(20_000);
    out += decoder.write(line.subarray(70_000));
    out += decoder.end();
    expect(out).toBe("好".repeat(30_000));
  });

  it("reads other code pages by their own names", () => {
    // 「日本語」 in Shift_JIS, 「한국어」 in EUC-KR, 「é」 in Windows-1252.
    expect(
      all(new ConsoleDecoder("shift_jis"), [
        Buffer.from([0x93, 0xfa, 0x96, 0x7b, 0x8c, 0xea, 0x0a]),
      ]),
    ).toBe("日本語\n");
    expect(
      all(new ConsoleDecoder("euc-kr"), [
        Buffer.from([0xc7, 0xd1, 0xb1, 0xb9, 0xbe, 0xee, 0x0a]),
      ]),
    ).toBe("한국어\n");
    expect(
      all(new ConsoleDecoder("windows-1252"), [
        Buffer.from([0x52, 0xe9, 0x70, 0x0a]),
      ]),
    ).toBe("Rép\n");
  });
});

describe("with no code page to fall back on, nothing changes", () => {
  it("text comes out as it comes in, exactly as a UTF-8 decoder gives it", () => {
    const chunks = [
      utf8("partial"),
      utf8(" line 你").subarray(0, 7),
      utf8(" line 你").subarray(7),
      GBK_ZHONGWEN,
      NL,
    ];
    const plain = new StringDecoder("utf8");
    const decoder = new ConsoleDecoder(null);
    for (const c of chunks) expect(decoder.write(c)).toBe(plain.write(c));
    expect(decoder.end()).toBe(plain.end());
  });

  it("a name this runtime cannot read is no code page", () => {
    expect(all(new ConsoleDecoder("no-such-encoding"), [utf8("a\n")])).toBe(
      "a\n",
    );
    expect(decodeConsoleOutput(GBK_ZHONGWEN, "no-such-encoding")).toBe(
      GBK_ZHONGWEN.toString("utf8"),
    );
  });
});

describe("a whole captured output", () => {
  it("is read line by line the same way", () => {
    const bytes = Buffer.concat([utf8("ok ✓\n"), GBK_ZHONGWEN, NL]);
    expect(decodeConsoleOutput(bytes, "gb18030")).toBe("ok ✓\n中文\n");
    expect(decodeConsoleOutput(bytes, null)).toBe(bytes.toString("utf8"));
  });

  it("UTF-8 cut inside its last character is still UTF-8", () => {
    // A capture that stopped at its cap: the line is not another encoding.
    const cut = utf8("结果：通过\n最后一行").subarray(0, -1);
    expect(decodeConsoleOutput(cut, "gb18030")).toBe("结果：通过\n最后一�");
  });

  it("a legacy line that ends the output is read whole", () => {
    expect(
      decodeConsoleOutput(
        Buffer.concat([utf8("x\n"), GBK_ZHONGWEN]),
        "gb18030",
      ),
    ).toBe("x\n中文");
  });
});

describe("which code page", () => {
  afterEach(() => setConsoleLegacyEncodingForTest(undefined));

  it("is read out of the registry's answer", () => {
    expect(
      parseAcp(
        "\r\nHKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\Nls\\CodePage\r\n    ACP    REG_SZ    936\r\n\r\n",
      ),
    ).toBe(936);
    expect(
      parseAcp("ERROR: The system was unable to find the key."),
    ).toBeNull();
  });

  it("has a name where it needs a second reading, and none where it is UTF-8", () => {
    expect(codePageLabel(936)).toBe("gb18030");
    expect(codePageLabel(950)).toBe("big5");
    expect(codePageLabel(932)).toBe("shift_jis");
    expect(codePageLabel(949)).toBe("euc-kr");
    expect(codePageLabel(1252)).toBe("windows-1252");
    expect(codePageLabel(1251)).toBe("windows-1251");
    expect(codePageLabel(65001)).toBeNull();
    expect(codePageLabel(437)).toBeNull();
  });

  it("is none until the machine has been asked, and a decoder follows it", () => {
    setConsoleLegacyEncodingForTest(undefined);
    expect(consoleLegacyEncoding()).toBeNull();
    expect(all(new ConsoleDecoder(), [GBK_ZHONGWEN, NL])).toContain("�");
    setConsoleLegacyEncodingForTest("gb18030");
    expect(consoleLegacyEncoding()).toBe("gb18030");
    expect(all(new ConsoleDecoder(), [GBK_ZHONGWEN, NL])).toBe("中文\n");
  });
});
