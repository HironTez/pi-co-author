import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { attributeCommit, commitIndex } from "../lib/co-author.mjs";

const identity = "Claude Sonnet 4.6 <noreply@anthropic.com>";
function trailers(message, extraConfig = []) {
  const args = attributeCommit(["commit"], identity);
  const index = commitIndex(args);
  // Exercise the exact Git trailer configuration without creating a repository.
  return execFileSync("git", [...extraConfig, ...args.slice(0, index), "interpret-trailers", ...args.slice(index + 1)], {
    input: message,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
  });
}

test("native Git formats trailers and preserves other authors", () => {
  const message = trailers("Subject\n\nBody\n\nCo-authored-by: Human <human@example.invalid>\n");
  assert.equal(message, `Subject\n\nBody\n\nCo-authored-by: Human <human@example.invalid>\nCo-authored-by: ${identity}\n`);
});

test("native Git suppresses matching trailers anywhere in the trailer block", () => {
  const initial = `Subject\n\nCo-authored-by: ${identity}\nCo-authored-by: Human <human@example.invalid>\n`;
  assert.equal(trailers(initial), initial);
  assert.equal(trailers(trailers(initial)), initial);
});

test("per-call trailer configuration takes precedence without persistent edits", () => {
  const message = trailers("Subject\n", ["-c", "trailer.co-authored-by.ifmissing=doNothing", "-c", "trailer.co-authored-by.ifexists=replace"]);
  assert.equal(message, `Subject\n\nCo-authored-by: ${identity}\n`);
});
