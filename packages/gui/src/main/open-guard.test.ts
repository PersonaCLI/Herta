import { describe, expect, it } from "vitest";
import { opensByRunning } from "./open-guard.js";

const win = (path: string, pathext?: string): boolean =>
  opensByRunning({ path, platform: "win32", pathext });
const mac = (path: string, executable = false): boolean =>
  opensByRunning({ path, platform: "darwin", executable });
const linux = (path: string, executable = false): boolean =>
  opensByRunning({ path, platform: "linux", executable });

describe("opensByRunning — what 打开 shows in its folder instead (review 2026-11-10)", () => {
  it("Windows: a program, a script, a shortcut and an installer would run", () => {
    for (const name of [
      "setup.exe",
      "build.bat",
      "run.cmd",
      "deploy.ps1",
      "index.js",
      "macro.vbs",
      "page.hta",
      "tool.py",
      "app.jar",
      "Readme.lnk",
      "site.url",
      "keys.reg",
      "pkg.msi",
    ]) {
      expect(win(`C:\\ws\\out\\${name}`), name).toBe(true);
    }
  });

  it("Windows: a document, a source file and a folder open as before", () => {
    for (const name of [
      "report.docx",
      "paper.pdf",
      "photo.PNG",
      "index.ts",
      "notes.md",
      "data.json",
      "styles.css",
      "README",
      "Makefile",
      "src",
    ]) {
      expect(win(`C:\\ws\\${name}`), name).toBe(false);
    }
    expect(win("C:\\ws")).toBe(false);
  });

  it("Windows: a type is read whatever its case, and behind what Win32 drops", () => {
    expect(win("C:\\ws\\SETUP.EXE")).toBe(true);
    expect(win("C:/ws/run.Bat")).toBe(true);
    expect(win("C:\\ws\\run.bat.")).toBe(true);
    expect(win("C:\\ws\\run.bat  ")).toBe(true);
    expect(win("C:\\ws\\run.bat::$DATA")).toBe(true);
    expect(win("C:\\ws\\notes.txt:hidden.exe")).toBe(true);
    expect(win("C:\\ws\\.exe")).toBe(true);
    // The last type is the one the shell reads.
    expect(win("C:\\ws\\invoice.pdf.exe")).toBe(true);
    expect(win("C:\\ws\\setup.exe.txt")).toBe(false);
    // Only the last segment: a folder's name decides nothing for its files.
    expect(win("C:\\ws\\tools.exe\\notes.txt")).toBe(false);
  });

  it("Windows: the machine's PATHEXT adds the types it runs", () => {
    expect(win("C:\\ws\\task.rb")).toBe(false);
    expect(win("C:\\ws\\task.rb", ".COM;.EXE;.BAT;.CMD;.RB")).toBe(true);
    expect(win("C:\\ws\\task.RB", " .rb ; ;")).toBe(true);
    expect(win("C:\\ws\\notes.md", ".COM;.EXE;;")).toBe(false);
  });

  it("macOS: a bundle, a Terminal script and an installer would run; a script with a type opens in its editor", () => {
    expect(mac("/ws/Tool.app")).toBe(true);
    expect(mac("/ws/go.command")).toBe(true);
    expect(mac("/ws/setup.pkg")).toBe(true);
    expect(mac("/ws/here.inetloc")).toBe(true);
    expect(mac("/ws/app.jar")).toBe(true);
    expect(mac("/ws/index.js")).toBe(false);
    expect(mac("/ws/tool.py")).toBe(false);
    expect(mac("/ws/build.sh", true)).toBe(false);
    expect(mac("/ws/paper.pdf")).toBe(false);
  });

  it("off Windows: a file with an execute bit and no type would run", () => {
    expect(mac("/ws/bin/build", true)).toBe(true);
    expect(mac("/ws/bin/build", false)).toBe(false);
    expect(mac("/ws/.hook", true)).toBe(true);
    expect(linux("/ws/bin/build", true)).toBe(true);
    expect(linux("/ws/README")).toBe(false);
    // A backslash is a letter of the name here, not a separator.
    expect(linux("/ws/odd\\name.txt")).toBe(false);
  });

  it("Linux: a launcher and an AppImage would run, and so would what Wine opens", () => {
    expect(linux("/ws/Tool.desktop")).toBe(true);
    expect(linux("/ws/Tool.AppImage")).toBe(true);
    expect(linux("/ws/setup.exe")).toBe(true);
    expect(linux("/ws/index.js")).toBe(false);
    expect(linux("/ws/run.bat")).toBe(false);
    expect(linux("/ws/notes.txt", true)).toBe(false);
  });
});
