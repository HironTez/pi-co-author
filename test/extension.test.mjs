import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { accessSync } from "node:fs";
import extension from "../extensions/co-author.ts";

function setup(t) {
  const handlers = new Map();
  const commands = new Map();
  const notices = [];
  const selected = { id: "gpt-5.4", name: "GPT-5.4", provider: "openai" };
  const claude = { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", provider: "anthropic" };
  const ctx = {
    model: selected,
    modelRegistry: { find: (provider, id) => provider === claude.provider && id === claude.id ? claude : undefined },
    ui: { notify: (message, level) => notices.push({ message, level }) },
  };
  extension({ on: (name, handler) => handlers.set(name, handler), registerCommand: (name, definition) => commands.set(name, definition) });
  const emit = async (name, event = {}) => handlers.get(name)?.(event, ctx);
  t.after(() => emit("session_shutdown"));
  const call = async (command = "printf '%s' \"$PI_CO_AUTHOR_IDENTITY\"") => {
    const event = { type: "tool_call", toolName: "bash", toolCallId: "test", input: { command } };
    await emit("tool_call", event);
    return event;
  };
  return { handlers, commands, notices, ctx, emit, call };
}

function execute(event) {
  return execFileSync("bash", ["-c", event.input.command], { encoding: "utf8" });
}

test("selected model is fallback; emitting assistant model takes precedence", async (t) => {
  const { emit, call, ctx } = setup(t);
  assert.equal(execute(await call()), "GPT-5.4 <noreply@openai.com>");
  await emit("message_end", { message: { role: "assistant", model: "claude-sonnet-4-6", provider: "anthropic" } });
  const claudeCall = await call();
  ctx.model = { id: "other", name: "Other", provider: "local" };
  assert.equal(execute(claudeCall), "Claude Sonnet 4.6 <noreply@anthropic.com>");
  await emit("message_end", { message: { role: "assistant", model: "unregistered", provider: "custom" } });
  assert.equal(execute(await call()), "unregistered <custom-unregistered@models.invalid>");
  await emit("before_agent_start");
  assert.equal(execute(await call()), "Other <local-other@models.invalid>");
});

test("on/off/status controls and non-Bash calls", async (t) => {
  const { commands, notices, emit, call } = setup(t);
  assert.equal(commands.size, 1);
  await commands.get("co-author").handler("off", { ui: { notify: (message) => notices.push({ message }) } });
  assert.equal((await call("git status")).input.command, "git status");
  await commands.get("co-author").handler("on", { ui: { notify: () => {} } });
  assert.ok((await call("git status")).input.command.includes("PI_CO_AUTHOR_IDENTITY"));
  const event = { toolName: "read", input: { path: "file" } };
  await emit("tool_call", event); assert.deepEqual(event.input, { path: "file" });
  const other = { toolName: "bash", input: {} };
  await emit("tool_call", other); assert.deepEqual(other.input, {});
});

test("only tool_call is intercepted, not user Bash; no model blocks rather than guesses", async (t) => {
  const { handlers, emit, ctx } = setup(t);
  assert.equal(handlers.has("user_bash"), false);
  ctx.model = undefined;
  const event = { toolName: "bash", input: { command: "git commit -m x" } };
  const result = await emit("tool_call", event);
  assert.equal(result.block, true);
  assert.equal(event.input.command, "git commit -m x");
});

test("parallel nested tool calls snapshot identity and share private shim; shutdown cleans it", async (t) => {
  const { call, emit } = setup(t);
  const events = await Promise.all(Array.from({ length: 5 }, () => call("command -v git")));
  const paths = events.map(execute);
  assert.equal(new Set(paths).size, 1);
  accessSync(paths[0].trim());
  await emit("session_shutdown");
  assert.throws(() => accessSync(paths[0].trim()));
  await emit("session_shutdown"); // Idempotent.
  const event = { toolName: "bash", parentToolCallId: "codemode-call", input: { command: "printf '%s' \"$PI_CO_AUTHOR_IDENTITY\"" } };
  await emit("tool_call", event);
  assert.equal(execute(event), "GPT-5.4 <noreply@openai.com>");
});
