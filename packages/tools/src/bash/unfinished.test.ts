import { describe, expect, it } from "vitest";
import { findBash } from "./find-bash.js";
import { mayBeUnfinished, unfinishedInput } from "./unfinished.js";

// 2026-11-19: an open quote or a heredoc with no terminator held a bash call
// until its timeout and lost the shell. bash's own parser decides; the cheap
// look only says when to ask it.

const BS = "\\";
const BASH = findBash();

describe("mayBeUnfinished — when bash is worth asking", () => {
  it("an open quote or a heredoc with no terminator", () => {
    for (const line of [
      'echo "unterminated',
      "echo 'unterminated",
      "echo $'unterminated",
      "cat <<EOF\nbody",
      "cat <<-'EOF'\n\tbody\n",
    ]) {
      expect(mayBeUnfinished(line), line).toBe(true);
    }
  });

  it("closed quotes, closed heredocs whose bodies hold quotes, comments, escapes", () => {
    for (const line of [
      `echo "it's fine"`,
      `cat > f <<'EOF'\nit's a body with a " quote\nEOF`,
      "cat <<-EOF\n\tbody\n\tEOF",
      "# don't worry\necho ok",
      `echo don${BS}'t`,
      `echo "a ${BS}" b"`,
      "echo $'a\\'b'",
      "cat <<<'here-string'",
    ]) {
      expect(mayBeUnfinished(line), line).toBe(false);
    }
  });
});

describe.skipIf(BASH === null)(
  "unfinishedInput — bash's own parser decides",
  () => {
    it("an open quote and a heredoc with no terminator are unfinished", async () => {
      for (const line of ['echo "x', "echo 'x", "cat <<EOF\nbody"]) {
        expect(
          await unfinishedInput(line, BASH as string),
          line,
        ).not.toBeNull();
      }
    });

    it("text the cheap look doubted but bash reads as whole is not", async () => {
      // `<<` inside quotes looks like a heredoc to the cheap look.
      expect(
        await unfinishedInput('echo "a <<EOF"', BASH as string),
      ).toBeNull();
    });

    it("when bash cannot be asked, nothing is refused", async () => {
      expect(
        await unfinishedInput('echo "x', "/no/such/bash-program"),
      ).toBeNull();
    });
  },
);
