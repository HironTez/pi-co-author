import test from "node:test";
import assert from "node:assert/strict";
import { attributeCommit, coAuthor, commitIndex, shellQuote, wrapCommand } from "../lib/co-author.mjs";

const identity = "Claude Sonnet 4.6 <noreply@anthropic.com>";

test("model identities cover direct providers, aggregators, and custom models", () => {
  for (const [model, expected] of [
    [{ provider: "anthropic", id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" }, identity],
    [{ provider: "openai-codex", id: "gpt-5.4", name: "GPT-5.4" }, "GPT-5.4 <noreply@openai.com>"],
    [{ provider: "openrouter", id: "anthropic/claude-opus-4.6" }, "anthropic/claude-opus-4.6 <noreply@anthropic.com>"],
    [{ provider: "openrouter", id: "openai/o3" }, "openai/o3 <noreply@openai.com>"],
    [{ provider: "google-vertex", id: "gemini-2.5-pro", name: "Gemini 2.5 Pro" }, "Gemini 2.5 Pro <noreply@google.com>"],
    [{ provider: "local", id: "my/model", name: "My Model" }, "My Model <local-my-model@models.invalid>"],
  ]) assert.equal(coAuthor(model, {}), expected);
});

test("identity overrides and injection validation", () => {
  const model = { provider: "local", id: "test" };
  assert.equal(coAuthor(model, { PI_CO_AUTHOR_NAME: "Our AI", PI_CO_AUTHOR_EMAIL: "ai@example.com" }), "Our AI <ai@example.com>");
  for (const name of ["", "\nForged: value", "AI <fake>", "AI\u0000"]) {
    assert.throws(() => coAuthor(model, { PI_CO_AUTHOR_NAME: name }));
  }
  for (const email of ["", "no-email", "a@b\nTrailer: forged", "x <a@b>", "a@b\u0000"]) {
    assert.throws(() => coAuthor(model, { PI_CO_AUTHOR_EMAIL: email }));
  }
});

test("commit parser understands Git global options without confusing values", () => {
  for (const [args, expected] of [
    [["commit", "-m", "hi"], 0],
    [["-C", "commit", "commit", "-m", "hi"], 2],
    [["-c", "alias.x=commit", "status"], -1],
    [["-C../repo", "-ccore.quotePath=false", "commit"], 2],
    [["--git-dir", "/tmp/commit", "--work-tree=/tmp", "commit"], 3],
    [["--config-env=foo=VAR", "--no-pager", "commit"], 2],
    [["--namespace", "commit", "--bare", "commit"], 3],
    [["--version"], -1], [["log", "--grep=commit"], -1],
    [["status", "commit"], -1], [["--future-unknown", "commit"], -1],
  ]) assert.equal(commitIndex(args), expected, args.join(" "));
});

test("attribution preserves arguments including pathspec separator", () => {
  const args = ["-C", "/repo", "commit", "-m", "a 'quote'", "--", "file"];
  const result = attributeCommit(args, identity);
  assert.deepEqual(result.slice(0, 2), args.slice(0, 2));
  assert.deepEqual(result.slice(-4), args.slice(3));
  assert.ok(result.includes(`--trailer=Co-authored-by: ${identity}`));
  const status = ["status", "--short"];
  assert.equal(attributeCommit(status, identity), status);
});

test("commit help requests pass through unchanged without confusing message values", () => {
  for (const args of [["commit", "--help"], ["-C", "/repo", "commit", "-h"]]) {
    assert.equal(attributeCommit(args, identity), args);
  }
  assert.ok(attributeCommit(["commit", "-m", "--help"], identity).includes(`--trailer=Co-authored-by: ${identity}`));
});

test("shell wrapping safely quotes identity and preserves the original command", () => {
  assert.equal(shellQuote("a'b"), `'a'"'"'b'`);
  const command = "printf '%s\\n' hello # comment";
  const result = wrapCommand(command, "/tmp/with ' quotes", "AI's $(touch /tmp/nope) <a@b>");
  assert.ok(result.includes(`${command}\n)`));
  assert.ok(result.includes("export PI_CO_AUTHOR_ORIGINAL_PATH=\"$PATH\""));
});
