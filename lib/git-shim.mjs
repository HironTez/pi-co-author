import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { delimiter, resolve } from "node:path";
import { constants as osConstants } from "node:os";
import { spawn } from "node:child_process";
import { attributeCommit } from "./co-author.mjs";

// Resolve against the saved PATH rather than hard-coding /usr/bin/git. This
// preserves existing Git wrappers (including authentication/clone guardrails)
// and resolves relative PATH entries against the Git invocation's directory.
async function findGit() {
  const path = process.env.PI_CO_AUTHOR_ORIGINAL_PATH;
  if (path === undefined) throw new Error("Missing original Git PATH");
  for (const directory of path.split(delimiter)) {
    const candidate = resolve(directory || ".", "git");
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch { /* Try the next PATH entry. */ }
  }
  throw new Error("git was not found in the original PATH");
}

try {
  const executable = await findGit();
  const identity = process.env.PI_CO_AUTHOR_IDENTITY;
  if (!identity) throw new Error("Missing co-author identity");
  const child = spawn(executable, attributeCommit(process.argv.slice(2), identity), {
    stdio: "inherit",
    env: process.env,
  });
  // Pi cancels the entire process group. Forward individual signals as well.
  for (const signal of /** @type {const} */ (["SIGINT", "SIGTERM", "SIGHUP"])) {
    process.on(signal, () => child.kill(signal));
  }
  child.on("error", (error) => {
    console.error(`pi-co-author: ${error.message}`);
    process.exitCode = 127;
  });
  child.on("exit", (code, signal) => {
    process.exitCode = signal ? 128 + (osConstants.signals[signal] ?? 0) : (code ?? 1);
  });
} catch (error) {
  console.error(`pi-co-author: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 127;
}
