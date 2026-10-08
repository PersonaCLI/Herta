import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { zh } from "../../i18n/messages/zh.js";
import { isDangerRisk, REASON_KEY, RISK_KEY } from "./risk-label.js";

/** Every `command_ask_*` code the classifiers' sources can return. */
function askCodesInTools(): Set<string> {
  const root = fileURLToPath(
    new URL("../../../../../tools/src/", import.meta.url),
  );
  const codes = new Set<string>();
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (name.endsWith(".ts") && !name.endsWith(".test.ts")) {
        for (const m of readFileSync(path, "utf8").matchAll(
          /"(command_ask_[a-z_]+)"/g,
        )) {
          codes.add(m[1] as string);
        }
      }
    }
  };
  walk(root);
  return codes;
}

describe("risk-label", () => {
  it("maps each RiskLevel to its message key", () => {
    expect(RISK_KEY.workspace_read).toBe("approval.risk.read");
    expect(RISK_KEY.workspace_write).toBe("approval.risk.write");
    expect(RISK_KEY.workspace_destructive).toBe("approval.risk.destructive");
    expect(RISK_KEY.network).toBe("approval.risk.network");
  });

  it("every ask class the classifiers can return has card copy — none falls back to the raw English reason (ADR 0075 step 1)", () => {
    // Four classes had none, so a zh card showed "runs a workspace program:
    // ./bin/x" and the like verbatim; the two classes ADR 0075 added would
    // have joined them.
    const codes = askCodesInTools();
    expect(codes.has("command_ask_download_exec")).toBe(true);
    expect(codes.has("command_ask_opaque")).toBe(true);
    for (const code of codes) {
      const key = REASON_KEY[code];
      expect(key, code).toBeDefined();
      expect(zh[key as keyof typeof zh], code).toMatch(/[\u4e00-\u9fff]/);
    }
  });

  it("flags only destructive risk as danger", () => {
    expect(isDangerRisk("workspace_destructive")).toBe(true);
    expect(isDangerRisk("workspace_write")).toBe(false);
    expect(isDangerRisk("workspace_read")).toBe(false);
    expect(isDangerRisk("network")).toBe(false);
  });
});
