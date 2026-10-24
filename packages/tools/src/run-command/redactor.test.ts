import { describe, expect, it } from "vitest";
import { redactSecrets } from "./redactor.js";

describe("redactSecrets", () => {
  it("redacts AWS access keys", () => {
    const r = redactSecrets("key=AKIAIOSFODNN7EXAMPLE end");
    expect(r).toContain("[REDACTED:aws_access_key]");
    expect(r).not.toContain("AKIAIOSFODNN7EXAMPLE");
  });

  it("redacts GitHub tokens", () => {
    const r = redactSecrets("ghp_1234567890abcdefghijklmnopqrstuvwxyz0");
    expect(r).toContain("[REDACTED:github_token]");
  });

  it("redacts JWT-shaped tokens", () => {
    const r = redactSecrets(
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c",
    );
    expect(r).toContain("[REDACTED:jwt]");
  });

  it("redacts bearer tokens", () => {
    const r = redactSecrets("Authorization: Bearer abcdef0123456789ABCDEF0123");
    expect(r).toContain("[REDACTED:bearer]");
  });

  it("redacts env-style secrets, preserving the key name", () => {
    const r = redactSecrets("API_KEY=sk_test_123abcdefg");
    expect(r).toContain("API_KEY=[REDACTED:env_secret]");
    expect(r).not.toContain("sk_test_123abcdefg");
  });

  it("redacts SECRET, PASSWORD, TOKEN, PRIVATE_KEY env-style", () => {
    expect(redactSecrets("SECRET=foo")).toContain(
      "SECRET=[REDACTED:env_secret]",
    );
    expect(redactSecrets("PASSWORD=foo")).toContain(
      "PASSWORD=[REDACTED:env_secret]",
    );
    expect(redactSecrets("TOKEN=foo")).toContain("TOKEN=[REDACTED:env_secret]");
    expect(redactSecrets("PRIVATE_KEY=foo")).toContain(
      "PRIVATE_KEY=[REDACTED:env_secret]",
    );
  });

  // 2026-07-10 audit (finding 2b): every line below was MEASURED leaking
  // through the original redactor. Keep these as literal regressions.

  it("redacts prefixed env names (leading \\b never matched past a _)", () => {
    const r = redactSecrets("DEEPSEEK_API_KEY=sk-supersecret123456789");
    expect(r).not.toContain("supersecret");
    const r2 = redactSecrets(
      "AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    );
    expect(r2).not.toContain("wJalrXUtnFEMI");
    expect(r2).toContain("AWS_SECRET_ACCESS_KEY");
  });

  it("redacts quoted env values", () => {
    expect(redactSecrets('PASSWORD="hunter2"')).not.toContain("hunter2");
    expect(redactSecrets("TOKEN='abc123def456'")).not.toContain("abc123def456");
  });

  it("redacts sk- / sk-proj- API keys", () => {
    expect(
      redactSecrets("OPENAI_API_KEY=sk-proj-AAAAAAAAAAAAAAAAAAAAAAAA"),
    ).not.toContain("sk-proj-AAAA");
    expect(redactSecrets("bare sk-abcdef0123456789abcdef in prose")).toContain(
      "[REDACTED:api_key]",
    );
  });

  it("redacts Slack, Stripe, npm, and Google keys", () => {
    expect(redactSecrets("slack=xoxb-123456789012-abcdefghijkl")).not.toContain(
      "xoxb-123456789012",
    );
    expect(redactSecrets("sk_live_abcdefghij0123456789")).toContain(
      "[REDACTED:stripe_key]",
    );
    expect(redactSecrets("npm_abcdefghijklmnopqrstuvwxyz0123456789")).toContain(
      "[REDACTED:npm_token]",
    );
    expect(redactSecrets("AIzaSyA1234567890abcdefghijklmnopqrstuv")).toContain(
      "[REDACTED:google_api_key]",
    );
  });

  it("redacts a whole PEM private-key block, not just the header", () => {
    const pem =
      "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA0Zx\nBODYLINE2\n-----END RSA PRIVATE KEY-----";
    const r = redactSecrets(`before\n${pem}\nafter`);
    expect(r).toContain("before");
    expect(r).toContain("after");
    expect(r).toContain("[REDACTED:private_key]");
    expect(r).not.toContain("MIIEowIBAAKCAQEA0Zx");
    expect(r).not.toContain("BODYLINE2");
  });

  it("redacts a truncated PEM block (END marker cut off) to end-of-text", () => {
    const r = redactSecrets(
      "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkq\nleftover",
    );
    expect(r).not.toContain("MIIEvQIBADANBgkq");
  });

  it("passes plain text through unchanged", () => {
    expect(redactSecrets("hello world")).toBe("hello world");
  });

  it("leaves code that reads a secret, and still masks one written down (page-app lab, 2026-10-24)", () => {
    for (const line of [
      "const password = form.elements.password.value;",
      "API_KEY = process.env.API_KEY",
      'token = os.getenv("TOKEN")',
      "if (password === confirmPassword) return;",
      "const isSecret = (secret) => secret.length > 0;",
    ])
      expect(redactSecrets(line)).toBe(line);
    expect(redactSecrets("password=hunter2")).toBe(
      "password=[REDACTED:env_secret]",
    );
    expect(redactSecrets("PASSWORD=p.ssw0rd")).toBe(
      "PASSWORD=[REDACTED:env_secret]",
    );
    expect(redactSecrets('const password = "hunter2";')).not.toContain(
      "hunter2",
    );
    expect(redactSecrets("db.password=s3cret")).not.toContain("s3cret");
  });

  it("redacts only the secret in multi-line text", () => {
    const r = redactSecrets("line1\nAKIAIOSFODNN7EXAMPLE\nline3");
    expect(r).toContain("line1");
    expect(r).toContain("line3");
    expect(r).toContain("[REDACTED:aws_access_key]");
    expect(r).not.toContain("AKIAIOSFODNN7EXAMPLE");
  });
});
