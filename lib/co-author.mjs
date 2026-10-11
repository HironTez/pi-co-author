/** @typedef {{ id: string, name?: string, provider: string }} ModelIdentity */

/**
 * These are attribution addresses, not an assertion of verified vendor identity.
 * Models behind aggregators are recognized by model ID before provider name.
 * @param {ModelIdentity} model
 * @param {NodeJS.ProcessEnv} [env]
 */
export function coAuthor(model, env = process.env) {
  const id = model.id.toLowerCase();
  const provider = model.provider.toLowerCase();
  let domain;
  if (/claude|anthropic/.test(id)) domain = "anthropic.com";
  else if (/(^|[/])(?:gpt-|chatgpt-|o[134](?:-|$))/.test(id)) domain = "openai.com";
  else if (/gemini/.test(id)) domain = "google.com";
  else if (/anthropic/.test(provider)) domain = "anthropic.com";
  else if (/openai/.test(provider)) domain = "openai.com";
  else if (/google/.test(provider)) domain = "google.com";

  const slug = `${model.provider}-${model.id}`.toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64) || "model";
  const name = env.PI_CO_AUTHOR_NAME ?? model.name ?? model.id;
  const email = env.PI_CO_AUTHOR_EMAIL ?? (domain ? `noreply@${domain}` : `${slug}@models.invalid`);
  if (!name.trim() || /[\r\n\x00-\x1f\x7f<>]/.test(name)) {
    throw new Error("Co-author name must be nonempty and cannot contain control characters or angle brackets");
  }
  if (!/^[^\s<>\x00-\x1f\x7f]+@[^\s<>\x00-\x1f\x7f]+$/.test(email)) {
    throw new Error("Co-author email must be a single valid attribution address");
  }
  return `${name.trim()} <${email}>`;
}

/** @param {string} value */
export function shellQuote(value) {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

/**
 * Identify an explicit commit subcommand, without parsing the shell or changing
 * other Git commands. Unknown global flags are passed through unchanged.
 * @param {string[]} args
 */
export function commitIndex(args) {
  const withValue = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--config-env", "--super-prefix"]);
  const standalone = new Set(["--no-pager", "--paginate", "-p", "-P", "--bare", "--no-replace-objects", "--literal-pathspecs", "--glob-pathspecs", "--noglob-pathspecs", "--icase-pathspecs", "--no-optional-locks", "--no-lazy-fetch", "--no-advice"]);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith("-")) return arg === "commit" ? i : -1;
    if (withValue.has(arg)) { i++; continue; }
    if (standalone.has(arg)) continue;
    if (/^(?:-C.|-c.|--(?:git-dir|work-tree|namespace|config-env|super-prefix)=)/.test(arg)) continue;
    return -1;
  }
  return -1;
}

/** @param {string[]} args @param {string} identity */
export function attributeCommit(args, identity) {
  const index = commitIndex(args);
  // Git dispatches `git commit --help` before normal commit option parsing.
  // Prepending --trailer would turn the man-page request into a usage error.
  if (index < 0 || args[index + 1] === "--help" || args[index + 1] === "-h") return args;
  return [
    ...args.slice(0, index),
    "-c", "trailer.co-authored-by.key=Co-authored-by",
    "-c", "trailer.co-authored-by.ifexists=addIfDifferent",
    "-c", "trailer.co-authored-by.ifmissing=add",
    "-c", "trailer.co-authored-by.where=end",
    "commit", `--trailer=Co-authored-by: ${identity}`,
    ...args.slice(index + 1),
  ];
}

/**
 * A subshell isolates the environment, while child scripts inherit attribution.
 * Save PATH at execution time, after the user's shellCommandPrefix has run.
 * @param {string} command @param {string} directory @param {string} identity
 */
export function wrapCommand(command, directory, identity) {
  return `(\nexport PI_CO_AUTHOR_ORIGINAL_PATH="$PATH"\nexport PI_CO_AUTHOR_IDENTITY=${shellQuote(identity)}\nexport PATH=${shellQuote(directory)}:"$PATH"\n${command}\n)`;
}
