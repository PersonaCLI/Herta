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

describe("a fine-grained GitHub token (review 2026-11-10)", () => {
  it("is masked like the classic one", () => {
    const pat = `github_pat_11ABCDEFG0aBcDeFgHiJkL_${"a1B2".repeat(15)}`;
    expect(redactSecrets(`remote said ${pat} was revoked`)).toBe(
      "remote said [REDACTED:github_token] was revoked",
    );
    expect(redactSecrets("ghp_abcdefghijklmnopqrstuvwxyz0123456789")).toBe(
      "[REDACTED:github_token]",
    );
  });

  it("a name that starts the same way is not one", () => {
    const line = "github_pat_token and github_patterns";
    expect(redactSecrets(line)).toBe(line);
  });
});

describe("a password in a URL (review 2026-11-10)", () => {
  const mask = "[REDACTED:url_password]";

  it("is masked, and the user and the host stay", () => {
    for (const [line, masked] of [
      [
        "postgres://admin:s3cretPassw0rd@db.example.com/app",
        `postgres://admin:${mask}@db.example.com/app`,
      ],
      [
        "origin\thttps://robin:hunter2hunter2@git.example.com/team/repo.git (fetch)",
        `origin\thttps://robin:${mask}@git.example.com/team/repo.git (fetch)`,
      ],
      [
        "DATABASE_URL=postgres://admin:s3cretPassw0rd@db.example.com/app",
        `DATABASE_URL=postgres://admin:${mask}@db.example.com/app`,
      ],
      [
        "redis://:s3cretPassw0rd@cache.internal:6379/0",
        `redis://:${mask}@cache.internal:6379/0`,
      ],
      [
        "mongodb+srv://app:s3cretPassw0rd@cluster0.example.mongodb.net/db",
        `mongodb+srv://app:${mask}@cluster0.example.mongodb.net/db`,
      ],
      [
        "HTTP_PROXY=http://proxyuser:pr0xyPass@proxy.corp:8080",
        `HTTP_PROXY=http://proxyuser:${mask}@proxy.corp:8080`,
      ],
      ["http://admin:p@ss@[::1]:8080/", `http://admin:${mask}@[::1]:8080/`],
      [
        "git clone https://robin:hunter2hunter2@git.example.com/team/repo.git && cd repo",
        `git clone https://robin:${mask}@git.example.com/team/repo.git && cd repo`,
      ],
      [
        "https://oauth2:glpat-abcdefghij0123456789@gitlab.com/o/r.git",
        `https://oauth2:${mask}@gitlab.com/o/r.git`,
      ],
    ] as const) {
      expect(redactSecrets(line), line).toBe(masked);
    }
  });

  it("a token already masked inside one keeps its own marker", () => {
    expect(
      redactSecrets(
        "https://x-access-token:ghp_abcdefghijklmnopqrstuvwxyz0123456789@github.com/o/r.git",
      ),
    ).toBe("https://x-access-token:[REDACTED:github_token]@github.com/o/r.git");
  });

  it("an @ in a path, a user with no password and a port are not one", () => {
    for (const line of [
      "ssh://git@github.com/owner/repo.git",
      "ssh://git@github.com:22/owner/repo.git",
      "git@github.com:owner/repo.git",
      "https://user@example.com/path",
      "mailto:someone@example.com",
      "http://localhost:3000/login?next=/a@b",
      "https://unpkg.com/react@18.3.1/umd/react.production.min.js",
      "http://localhost:5173/@fs/C:/Users/dev/app/src/main.ts",
      "https://registry.npmjs.org/@scope/pkg",
      "see https://example.com:8443/a and mail me@example.com",
      "http://[::1]:8080/@vite/client",
      "docker://registry:5000/img@sha256:0123456789abcdef",
    ]) {
      expect(redactSecrets(line), line).toBe(line);
    }
  });

  it("a password a program fills in when it runs is left", () => {
    for (const line of [
      "postgres://$DB_USER:$DB_PASSWORD@db.internal/app",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: a line of code, not a template
      "postgres://${user}:${password}@${host}/${db}",
      'f"postgres://{user}:{password}@{host}/{db}"',
      "https://user:***@git.example.com/repo.git",
      '"mysql://%s:%s@%s/%s" % (user, pw, host, db)',
    ]) {
      expect(redactSecrets(line), line).toBe(line);
    }
  });
});

describe("Authorization: Basic (review 2026-11-10)", () => {
  it("masks the credentials wherever the header is written", () => {
    for (const [line, masked] of [
      [
        "Authorization: Basic dXNlcjpodW50ZXIyaHVudGVyMg==",
        "Authorization: Basic [REDACTED:basic_auth]",
      ],
      [
        "< Proxy-Authorization: Basic dXNlcjpodW50ZXIy",
        "< Proxy-Authorization: Basic [REDACTED:basic_auth]",
      ],
      [
        'curl -H "Authorization: Basic dXNlcjpodW50ZXIy" https://example.com',
        'curl -H "Authorization: Basic [REDACTED:basic_auth]" https://example.com',
      ],
      [
        '{"Authorization": "Basic dXNlcjpodW50ZXIy"}',
        '{"Authorization": "Basic [REDACTED:basic_auth]"}',
      ],
      [
        'headers.set("Authorization", "Basic dXNlcjpodW50ZXIy")',
        'headers.set("Authorization", "Basic [REDACTED:basic_auth]")',
      ],
      [
        "> authorization: basic dXNlcjpodW50ZXIy",
        "> authorization: basic [REDACTED:basic_auth]",
      ],
    ] as const) {
      expect(redactSecrets(line), line).toBe(masked);
    }
  });

  it("leaves the documentation's word and what a program works out", () => {
    for (const line of [
      "Authorization: Basic <credentials>",
      "Authorization: Basic credentials",
      "Authorization: Basic Authentication",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: a line of code, not a template
      "Authorization: `Basic ${encoded}`",
      '"Authorization": "Basic " + btoa(pair)',
      "Authorization: Basic base64encode(user:pass)",
      "Authorization: Basic $BASIC_CREDENTIALS",
      "Basic functionality works as before",
      '-H "Authorization: Basic $(echo -n user:pass | base64)"',
    ]) {
      expect(redactSecrets(line), line).toBe(line);
    }
  });
});

describe("a key and its value under a colon (review 2026-11-10)", () => {
  const mask = "[REDACTED:secret_value]";

  it("masks an opaque value in YAML, a header and a log's line", () => {
    for (const [line, masked] of [
      ["password: hunter2hunter2", `password: ${mask}`],
      ["  api_key: 9f8e7d6c5b4a39281706f5e4d3c2b1a0", `  api_key: ${mask}`],
      [
        "  client-secret: 0a1b2c3d4e5f60718293a4b5c6d7e8f9",
        `  client-secret: ${mask}`,
      ],
      [
        "  aws_secret_access_key: wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
        `  aws_secret_access_key: ${mask}`,
      ],
      ["  password: Sup3rS3cret!", `  password: ${mask}`],
      [
        "  - password: hunter2hunter2  # dev only",
        `  - password: ${mask}  # dev only`,
      ],
      [
        "spring.datasource.password: Xk9mP2nQ7vR4tL8w",
        `spring.datasource.password: ${mask}`,
      ],
      ["+  api_key: 9f8e7d6c5b4a39281706f5e4d3c2b1a0", `+  api_key: ${mask}`],
      [
        "config.yml:12:  password: hunter2hunter2",
        `config.yml:12:  password: ${mask}`,
      ],
      ["    12\t  password: hunter2hunter2", `    12\t  password: ${mask}`],
      [
        "> X-Api-Key: 9f8e7d6c5b4a39281706f5e4d3c2b1a0\r",
        `> X-Api-Key: ${mask}\r`,
      ],
      [
        "< x-auth-token: 550e8400-e29b-41d4-a716-446655440000",
        `< x-auth-token: ${mask}`,
      ],
      ["Generated password: Xk9mP2nQ7vR4", `Generated password: ${mask}`],
      ['echo "token: abc123def456ghi"', `echo "token: ${mask}"`],
      ["  password: aHVudGVyMmh1bnRlcjI=", `  password: ${mask}`],
      ["authtoken: 2abcDEF3ghiJKL4mnoPQR5stu", `authtoken: ${mask}`],
      [
        // biome-ignore lint/suspicious/noTemplateCurlyInString: a compose file's line, not a template
        "  POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:-abc123def456ghi}",
        `  POSTGRES_PASSWORD: ${mask}`,
      ],
    ] as const) {
      expect(redactSecrets(line), line).toBe(masked);
    }
  });

  it("masks a string with a digit in it, in JSON and in code", () => {
    for (const [line, masked] of [
      ['"token": "abcDEF123456xyz"', `"token": "${mask}"`],
      [
        '{"access_token":"ya29.a0AfH6SMBx7abcdefghij","expires_in":3599}',
        `{"access_token":"${mask}","expires_in":3599}`,
      ],
      [
        '  "apiKey": "9f8e7d6c5b4a39281706f5e4d3c2b1a0",',
        `  "apiKey": "${mask}",`,
      ],
      ["'password': 'hunter2hunter2'", `'password': '${mask}'`],
      ['  "password" : "hunter2",', `  "password" : "${mask}",`],
      ['    password: "Sup3rS3cret!"', `    password: "${mask}"`],
      [
        '  { user: "admin", password: "p4ssw0rd" }',
        `  { user: "admin", password: "${mask}" }`,
      ],
      ['  "client_secret": "a\\"b1c2d3e4f5",', `  "client_secret": "${mask}",`],
      ['  "db_password": "pass-word-1",', `  "db_password": "${mask}",`],
    ] as const) {
      expect(redactSecrets(line), line).toBe(masked);
    }
  });

  it("leaves a type, a property and a reference", () => {
    for (const line of [
      "  password: string;",
      "  token: string | null;",
      "    password: str",
      "    token: Optional[str] = None",
      "  secret: Uint8Array",
      "def login(user: str, password: str) -> bool:",
      "  apiKey: process.env.OPENAI_API_KEY,",
      "  token: process.env.GITHUB_TOKEN_2024",
      "  token: session.token,",
      "  password: await hash(input.password2),",
      "  token: getToken2024()",
      "  password: params[:password]",
      "  token: OAuth2AccessToken;",
      "function f(token: OAuth2AccessToken, key: CryptoKey) {",
      'token := os.Getenv("GITHUB_TOKEN_2")',
      "let kind = token::Kind1234567890;",
      "$token: 12px;",
    ]) {
      expect(redactSecrets(line), line).toBe(line);
    }
  });

  it("leaves a label, a message, a name, a count and a dependency", () => {
    for (const line of [
      '  "password": "Password",',
      '  "token": "Bearer",',
      '  "reset_password": "Reset your password",',
      '  "password": "Must be at least 8 characters",',
      '  "password": "",',
      '  "password": "your-password-here",',
      '  ACCESS_TOKEN: "access_token",',
      '  token: "app.auth.token",',
      '  "max_tokens": 4096,',
      '  "total_tokens": 1234,',
      '  "token": null,',
      '  "token": token,',
      '  "tokenizer": "cl100k_base",',
      '  "token_type": "Bearer",',
      '  "secretName": "tls-cert-2024",',
      '  "password": {"type": "string", "minLength": 8},',
      '  "bos_token": "<|begin_of_text|>",',
      '  "pad_token": "<|reserved_special_token_0|>",',
      '  "jsonwebtoken": "^9.0.2",',
      '  "jsonwebtoken": "10.12.3",',
      '  "rand-token": "~1.0.1",',
      '  "csrf-token": "workspace:^2.1.0",',
      "      jsonwebtoken: 9.0.2",
      "      jsonwebtoken: ^9.0.2",
      '  "private_key": "/etc/keys/dev2.pem",',
      '  "token": "https://auth.example.com/oauth2/v2/token",',
    ]) {
      expect(redactSecrets(line), line).toBe(line);
    }
  });

  it("leaves what is filled in when the file is used", () => {
    for (const line of [
      // biome-ignore lint/suspicious/noTemplateCurlyInString: a workflow's line, not a template
      "  token: ${{ secrets.GITHUB_TOKEN }}",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: a workflow's line, not a template
      "  password: ${{secrets.DOCKER_PASSWORD_2}}",
      "  password: {{ .Values.db.password }}",
      "  password: {{.Values.db.password2}}",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: a compose file's line, not a template
      "  POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: a compose file's line, not a template
      "  GITHUB_TOKEN: ${GITHUB_TOKEN_2024:-}",
      '  "access_token": "{{access_token2}}",',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: a config's line, not a template
      '  "token": "${TOKEN_V2}",',
      '  "password": "{password2}",',
      'curl -H "X-Api-Key: $API_KEY_2" https://example.com',
    ]) {
      expect(redactSecrets(line), line).toBe(line);
    }
  });

  it("leaves a sentence, a number, a path and YAML's own marks", () => {
    for (const line of [
      "SyntaxError: Unexpected token: punc (})",
      "error: Unexpected token: identifier",
      "  password: must contain 8 characters",
      "  token: expired, retrying in 30s",
      "Authorization: token is missing",
      "  private_key: ./keys/dev2.pem",
      "  private_key: /etc/ssl/private/server2024.key",
      "  token: 1700000000000",
      "  token: 2026-11-10T07:42:38Z",
      "  password: *default_password_1",
      "  password: !vault |",
      "      key: password",
    ]) {
      expect(redactSecrets(line), line).toBe(line);
    }
  });

  it("leaves a bare word: nothing tells it from a type's name", () => {
    // The price of `API_KEY: str` staying readable. The `=` rule has no
    // such doubt and masks `POSTGRES_PASSWORD=example`.
    for (const line of [
      "  POSTGRES_PASSWORD: example",
      "  password: hunter2",
      "    API_KEY: str",
    ]) {
      expect(redactSecrets(line), line).toBe(line);
    }
    expect(redactSecrets("POSTGRES_PASSWORD=example")).toBe(
      "POSTGRES_PASSWORD=[REDACTED:env_secret]",
    );
  });

  it("masks every one on a line, and the text between is left", () => {
    expect(
      redactSecrets(
        '{"access_token":"ya29.a0AfH6SMBx7","token_type":"Bearer","refresh_token":"1//0gLxyz123abc"}',
      ),
    ).toBe(
      `{"access_token":"${mask}","token_type":"Bearer","refresh_token":"${mask}"}`,
    );
  });
});

describe("the new shapes, read twice and read at length (review 2026-11-10)", () => {
  it("a masked line is left as it is", () => {
    for (const line of [
      "password: hunter2hunter2",
      '"token": "abcDEF123456xyz"',
      "postgres://admin:s3cretPassw0rd@db.example.com/app",
      "Authorization: Basic dXNlcjpodW50ZXIyaHVudGVyMg==",
      "DATABASE_URL=postgres://admin:s3cretPassw0rd@db.example.com/app",
      "TOKEN=abc123 password: hunter2hunter2",
    ]) {
      const once = redactSecrets(line);
      expect(once, line).not.toBe(line);
      expect(redactSecrets(once), line).toBe(once);
    }
  });

  it("is read in linear time, whatever it repeats", () => {
    const N = 300_000;
    const rep = (unit: string): string =>
      unit.repeat(Math.ceil(N / unit.length)).slice(0, N);
    for (const text of [
      rep(":"),
      rep("token: "),
      rep('"token": "'),
      rep("'token': \""),
      `token: 'x${rep("y ")}`,
      rep(`token:${" ".repeat(500)}`),
      `${rep("a-")}token: abc123def456ghi`,
      `${rep("token")}: abc123def456ghi`,
      `"${rep("token")}": "abc123def456"`,
      `token: ${rep("${a:-")}`,
      `token: ${rep("a1")}`,
      rep("://"),
      rep("x://u:p@"),
      `${rep("a")}://u:p@h`,
      `x://${rep("a:")}@h`,
      rep("Authorization: Basic "),
      `Authorization${rep(" ")}`,
      `Authorization: Basic ${rep("a")}(`,
      rep("github_pat_"),
    ]) {
      const started = performance.now();
      redactSecrets(text);
      expect(performance.now() - started, text.slice(0, 24)).toBeLessThan(
        1_000,
      );
    }
  });
});
