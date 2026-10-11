import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { coAuthor, shellQuote, wrapCommand } from "../lib/co-author.mjs";

type IdentityModel = { id: string; name?: string; provider: string };

export default function (pi: ExtensionAPI) {
  let enabled = process.env.PI_CO_AUTHOR_ENABLED !== "0";
  let generatedBy: IdentityModel | undefined;
  let shim: Promise<string> | undefined;

  // Lazily initialize only when a real tool call needs the shim. A shared
  // promise avoids races between parallel Bash calls. mkdtemp is private (0700).
  function getShim() {
    if (!shim) {
      shim = (async () => {
        const directory = await mkdtemp(join(tmpdir(), "pi-co-author-"));
        try {
          const script = fileURLToPath(new URL("../lib/git-shim.mjs", import.meta.url));
          await writeFile(join(directory, "git"),
            `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(script)} "$@"\n`,
            { mode: 0o700 });
          return directory;
        } catch (error) {
          await rm(directory, { recursive: true, force: true });
          throw error;
        }
      })().catch((error) => { shim = undefined; throw error; });
    }
    return shim;
  }

  // Use the model that emitted the tool call, including physical models behind
  // virtual routers, not whichever model happens to be selected afterward.
  pi.on("message_end", (event, ctx) => {
    if (event.message.role !== "assistant") return;
    const { model, provider } = event.message;
    generatedBy = ctx.modelRegistry.find(provider, model) ?? { id: model, provider };
  });
  pi.on("before_agent_start", () => { generatedBy = undefined; });
  pi.on("session_start", () => { generatedBy = undefined; });

  pi.on("tool_call", async (event, ctx) => {
    if (!enabled || event.toolName !== "bash" || typeof event.input.command !== "string") return;
    if (process.platform === "win32") {
      return { block: true, reason: "pi-co-author requires a POSIX host (Linux/macOS). Disable with /co-author off on native Windows." };
    }
    const model = generatedBy ?? ctx.model;
    if (!model) return { block: true, reason: "pi-co-author cannot attribute this Bash call: no model identity is available." };
    // Snapshot identity before awaiting so concurrent calls/model changes cannot
    // alter attribution for a tool call already in flight.
    const identity = coAuthor(model);
    event.input.command = wrapCommand(event.input.command, await getShim(), identity);
  });

  pi.registerCommand("co-author", {
    description: "Show Git model attribution, or toggle it on/off for this extension runtime",
    handler: async (args, ctx) => {
      const action = args.trim().toLowerCase() || "status";
      if (!["on", "off", "status"].includes(action)) {
        ctx.ui.notify("Usage: /co-author [on|off|status]", "warning");
        return;
      }
      if (action !== "status") enabled = action === "on";
      const model = ctx.model;
      ctx.ui.notify(enabled
        ? `Co-author attribution enabled${model ? `: ${coAuthor(model)}` : " (no model selected)"}`
        : "Co-author attribution disabled", "info");
    },
  });

  pi.on("session_shutdown", async () => {
    const pending = shim;
    shim = undefined;
    if (pending) {
      const directory = await pending.catch(() => undefined);
      if (directory) await rm(directory, { recursive: true, force: true });
    }
  });
}
