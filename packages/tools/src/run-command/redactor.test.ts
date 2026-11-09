import { describe, expect, it } from "vitest";
import { hasOpaqueWord, redactSecrets } from "./redactor.js";

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

  it("never takes the .env shape for code (review 2026-10-30, G4)", () => {
    for (const [line, secret] of [
      ["password=correct.horse.battery.staple", "horse"],
      ["TOKEN=part1.part2.part3", "part2"],
      ["DB_PASSWORD=foo(bar)", "foo"],
      ["PASSWORD==hunter2", "hunter2"],
      ["export API_KEY=a.b.c.d", "a.b.c"],
      ["curl -d secret=x.y.z https://example.com", "x.y.z"],
    ] as const)
      expect(redactSecrets(line)).not.toContain(secret);
  });

  it("reads a value of open parentheses in linear time (review 2026-10-30)", () => {
    for (const line of [
      `token=a${"(".repeat(28)})-`,
      `apiKey=e${"(.b.b.b".repeat(14)}-`,
      `secret=x${"(t".repeat(40)})-0`,
    ]) {
      const started = performance.now();
      expect(redactSecrets(line)).toContain("[REDACTED:env_secret]");
      expect(performance.now() - started).toBeLessThan(100);
    }
  });

  it("redacts only the secret in multi-line text", () => {
    const r = redactSecrets("line1\nAKIAIOSFODNN7EXAMPLE\nline3");
    expect(r).toContain("line1");
    expect(r).toContain("line3");
    expect(r).toContain("[REDACTED:aws_access_key]");
    expect(r).not.toContain("AKIAIOSFODNN7EXAMPLE");
  });
});

describe("what reads a secret and what holds one (review 2026-11-05, G8)", () => {
  it("a keyword argument is code, on its line or over several", () => {
    for (const line of [
      "client = OpenAI(api_key=settings.OPENAI_API_KEY)",
      'client = OpenAI(api_key=os.environ["OPENAI_API_KEY"])',
      'client = OpenAI(api_key=os.getenv("OPENAI_API_KEY"))',
      "connect(host=host, password=config.db.password, port=5432)",
      "connect(user=user, password=password)",
      "OpenAI(api_key=OPENAI_API_KEY)",
      "    api_key=settings.OPENAI_API_KEY,",
      "    12\t    token=self.token,",
    ]) {
      expect(redactSecrets(line), line).toBe(line);
    }
  });

  it("a value in a call is still a value when it is not plainly a name", () => {
    for (const line of [
      "connect(password=hunter2)",
      "User(id=1, token=abc123def456.ghi789jkl012)",
      "(TOKEN=abc.def.ghi)",
      "API_KEY=settings.foo,",
    ]) {
      expect(redactSecrets(line), line).toContain("[REDACTED:env_secret]");
    }
  });

  it("what a shell works out is left whole", () => {
    for (const line of [
      "TOKEN=$(gh auth token) npm publish",
      'TOKEN="$(gh auth token)" npm publish',
      "TOKEN=`gh auth token` npm publish",
      "TOKEN=$GITHUB_TOKEN npm publish",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: a shell line, not a template
      "API_KEY=${API_KEY} node run.js",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: a shell line, not a template
      'API_KEY="${API_KEY}" node run.js',
    ]) {
      expect(redactSecrets(line), line).toBe(line);
    }
  });

  it("what is written down is masked, whatever it starts with", () => {
    for (const line of [
      "PASSWORD=$ecret",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: a shell line, not a template
      "TOKEN=${FOO:-hunter2}",
      "TOKEN='$(not a substitution)'",
      'TOKEN="prefix $(gh auth token)"',
    ]) {
      expect(redactSecrets(line), line).toContain("[REDACTED:env_secret]");
    }
  });

  it("a dotted value at a config line's left edge is taken for a secret", () => {
    for (const line of [
      "password = correct.horse.battery.staple",
      "JWT_SECRET = v1.public.payload",
      "    12\tpassword = correct.horse.battery.staple",
      "app.ini:3:password = correct.horse.battery.staple",
    ]) {
      expect(redactSecrets(line), line).toContain("[REDACTED:env_secret]");
    }
  });

  it("a dotted value on a line that reads as code is not", () => {
    for (const line of [
      "const password = form.elements.password.value;",
      "let token = session.auth.token",
      "self.password = config.db.password",
      "    password = config.db.password",
      "src/db.py:12:    password = config.db.password",
      "    12\t    password = config.db.password",
    ]) {
      expect(redactSecrets(line), line).toBe(line);
    }
  });

  it("the .env shape stays masked", () => {
    for (const line of [
      "password=correct.horse.battery.staple",
      "TOKEN=part1.part2.part3",
      "DB_PASSWORD=foo(bar)",
      "PASSWORD==hunter2",
    ]) {
      expect(redactSecrets(line), line).toContain("[REDACTED:env_secret]");
    }
  });

  it("a minified line of keys reads no more of itself than the bound", () => {
    const line = "a(token=abc.def,".repeat(50_000);
    const started = performance.now();
    redactSecrets(line);
    expect(performance.now() - started).toBeLessThan(2_000);
  });
});

describe("one long word (review 2026-11-05, G11)", () => {
  it("is read in linear time, whatever it repeats", () => {
    for (const word of [
      "TOKEN",
      "eyJ-",
      "API_KEY",
      "sk-",
      "eyJaaaaaaaaaaaa.",
    ]) {
      const line = word.repeat(Math.ceil(300_000 / word.length));
      const started = performance.now();
      redactSecrets(line);
      expect(performance.now() - started, word).toBeLessThan(1_000);
    }
  });

  it("the jwt walk answers as the pattern did", () => {
    const pattern =
      /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g;
    const pieces = ["eyJ", "-", ".", "abcdefghij", "x", "_", " ", "abc", "é"];
    let seed = 7;
    const next = (n: number): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    for (let round = 0; round < 4000; round += 1) {
      let text = "";
      for (let i = next(12); i >= 0; i -= 1) {
        text += pieces[next(pieces.length)];
      }
      expect(redactSecrets(text), text).toBe(
        text.replace(pattern, "[REDACTED:jwt]"),
      );
    }
  });

  it("the env walk leaves a key's neighbour to be read", () => {
    expect(redactSecrets("foo=TOKEN=abc")).toBe(
      "foo=TOKEN=[REDACTED:env_secret]",
    );
    expect(redactSecrets('a=1 PASSWORD=x b=2 secret = "y"')).toBe(
      "a=1 PASSWORD=[REDACTED:env_secret] b=2 secret = [REDACTED:env_secret]",
    );
  });
});

describe("a long word with no digit in it (review 2026-11-10)", () => {
  it("is read in linear time behind a key", () => {
    for (const line of [
      `TOKEN=${"a".repeat(200_000)}`,
      `f(token=${"a".repeat(200_000)})`,
      `  password=${"snake_case_".repeat(20_000)},`,
    ]) {
      const started = performance.now();
      redactSecrets(line);
      expect(performance.now() - started, line.slice(0, 20)).toBeLessThan(500);
    }
  });

  it("the walk answers as the pattern did", () => {
    const pattern = /(?=\w*\d)\b\w{12,}\b/u;
    const pieces = ["abcdef", "x", "_", "7", "0123", ".", " ", "-", "é", "("];
    let seed = 11;
    const next = (n: number): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    for (let round = 0; round < 6000; round += 1) {
      let text = "";
      for (let i = next(8); i >= 0; i -= 1) {
        text += pieces[next(pieces.length)];
      }
      expect(hasOpaqueWord(text), text).toBe(pattern.test(text));
    }
  });

  it("still tells an opaque value from a name inside a call", () => {
    expect(
      redactSecrets("User(id=1, token=abc123def456.ghi789jkl012)"),
    ).not.toContain("abc123def456");
    expect(redactSecrets("connect(password=db_password,")).toBe(
      "connect(password=db_password,",
    );
  });
});
