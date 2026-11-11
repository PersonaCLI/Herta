import { describe, expect, it } from "vitest";
import { childProcessEnv } from "./child-env.js";

const APPDIR = "/tmp/.mount_HertaAbc123";

/** What AppRun hands Herta on a GNOME desktop. */
const appImageEnv: NodeJS.ProcessEnv = {
  APPIMAGE: "/home/u/Apps/Herta-x86_64.AppImage",
  APPDIR,
  OWD: "/home/u",
  ARGV0: "Herta-x86_64.AppImage",
  PATH: `${APPDIR}:${APPDIR}/usr/sbin:/home/u/.nvm/versions/node/v22/bin:/usr/bin:/bin`,
  LD_LIBRARY_PATH: `${APPDIR}/usr/lib`,
  XDG_DATA_DIRS: `${APPDIR}/usr/share/:/usr/local/share:/usr/share:/usr/share/gnome:/usr/local/share/:/usr/share/`,
  GSETTINGS_SCHEMA_DIR: `${APPDIR}/usr/share/glib-2.0/schemas`,
  HOME: "/home/u",
  LANG: "zh_CN.UTF-8",
};

describe("childProcessEnv (platform review 2026-09-23)", () => {
  it("strips the AppImage's own entries from what 板砖's children inherit", () => {
    const env = childProcessEnv(appImageEnv);
    expect(env.PATH).toBe("/home/u/.nvm/versions/node/v22/bin:/usr/bin:/bin");
    // Herta's bundled libraries no longer load into the user's programs.
    expect(env.LD_LIBRARY_PATH).toBeUndefined();
    expect(env.GSETTINGS_SCHEMA_DIR).toBeUndefined();
    expect(env.XDG_DATA_DIRS).not.toContain(APPDIR);
    expect(env.XDG_DATA_DIRS).toContain("/usr/share");
    for (const k of ["APPIMAGE", "APPDIR", "OWD", "ARGV0"]) {
      expect(env[k], k).toBeUndefined();
    }
    // Everything else is untouched.
    expect(env.HOME).toBe("/home/u");
    expect(env.LANG).toBe("zh_CN.UTF-8");
  });

  it("keeps a user's own LD_LIBRARY_PATH entries", () => {
    const env = childProcessEnv({
      ...appImageEnv,
      LD_LIBRARY_PATH: `${APPDIR}/usr/lib:/opt/cuda/lib64`,
    });
    expect(env.LD_LIBRARY_PATH).toBe("/opt/cuda/lib64");
  });

  it("does not mistake a sibling path that merely starts with APPDIR's name", () => {
    const env = childProcessEnv({
      ...appImageEnv,
      PATH: `${APPDIR}:${APPDIR}-tools/bin:/usr/bin`,
    });
    expect(env.PATH).toBe(`${APPDIR}-tools/bin:/usr/bin`);
  });

  it("outside an AppImage it is the same environment object — no copy, no change", () => {
    const plain: NodeJS.ProcessEnv = { PATH: "/usr/bin", HOME: "/home/u" };
    expect(childProcessEnv(plain)).toBe(plain);
    // APPDIR alone (some other AppDir tool) is not an AppImage launch.
    const appdirOnly: NodeJS.ProcessEnv = {
      APPDIR,
      PATH: `${APPDIR}:/usr/bin`,
    };
    expect(childProcessEnv(appdirOnly)).toBe(appdirOnly);
  });
});

describe("childProcessEnv — the harness's own key (review 2026-11-10)", () => {
  it("never reaches a child, under either name the harness reads it by", () => {
    const base: NodeJS.ProcessEnv = {
      PATH: "/usr/bin",
      DEEPSEEK_API_KEY: "sk-0123456789abcdef0123",
      HERTA_DEEPSEEK_API_KEY: "sk-fedcba9876543210fedc",
    };
    const env = childProcessEnv(base);
    expect(env.DEEPSEEK_API_KEY).toBeUndefined();
    expect(env.HERTA_DEEPSEEK_API_KEY).toBeUndefined();
    expect(JSON.stringify(env)).not.toContain("sk-");
    expect(env.PATH).toBe("/usr/bin");
    // The harness's own environment still has it: the next turn reads it.
    expect(base.DEEPSEEK_API_KEY).toBe("sk-0123456789abcdef0123");
  });

  it("is told by its name whatever the case, as Windows reads one", () => {
    const env = childProcessEnv({
      Path: "C:\\Windows",
      Deepseek_Api_Key: "sk-0123456789abcdef0123",
    });
    expect(Object.keys(env)).toEqual(["Path"]);
  });

  it("leaves every other key a project may need", () => {
    const base: NodeJS.ProcessEnv = {
      OPENAI_API_KEY: "sk-openai",
      GITHUB_TOKEN: "ghp_x",
      MY_DEEPSEEK_API_KEY_BACKUP: "sk-other",
      DEEPSEEK_API_BASE: "https://api.deepseek.com",
    };
    expect(childProcessEnv(base)).toBe(base);
  });

  it("goes with the AppImage's entries too", () => {
    const env = childProcessEnv({
      ...appImageEnv,
      DEEPSEEK_API_KEY: "sk-0123456789abcdef0123",
    });
    expect(env.DEEPSEEK_API_KEY).toBeUndefined();
    expect(env.APPIMAGE).toBeUndefined();
    expect(env.HOME).toBe("/home/u");
  });
});
