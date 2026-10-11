import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { shellQuote, wrapCommand } from "../lib/co-author.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const identity = "Claude Sonnet 4.6 <noreply@anthropic.com>";
const baseEnv = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" };

// Explicit binary override applies only to disposable fixture initialization.
// Normal agent commands still resolve Git through PATH to test wrapper chaining.
function initialize(repo) {
  const binary = process.env.PI_CO_AUTHOR_TEST_GIT;
  const account = process.env.PI_CO_AUTHOR_TEST_GH_ACCOUNT;
  if (binary) {
    assert.ok(binary.startsWith("/"), "PI_CO_AUTHOR_TEST_GIT must be an absolute binary path");
    execFileSync(binary, ["init", "-q", repo], { env: baseEnv, stdio: "pipe" });
  } else if (account) {
    execFileSync("git-gh-account", ["init", account, repo], { env: baseEnv, stdio: "pipe" });
  } else {
    execFileSync("git", ["init", "-q", repo], { env: baseEnv, stdio: "pipe" });
  }
}

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "pi-co-author-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const repo = join(directory, "repo with spaces");
  const shim = join(directory, "shim");
  mkdirSync(repo); mkdirSync(shim);
  writeFileSync(join(shim, "git"), `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(join(root, "lib/git-shim.mjs"))} "$@"\n`, { mode: 0o700 });
  const git = (...args) => execFileSync("git", args, { cwd: repo, env: baseEnv, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trimEnd();
  initialize(repo);
  git("config", "user.name", "Fixture User");
  git("config", "user.email", "fixture@example.invalid");
  git("config", "commit.gpgSign", "false");
  const run = (command, author = identity, env = {}) => execFileSync("bash", ["-c", wrapCommand(command, shim, author)], { cwd: repo, env: { ...baseEnv, ...env }, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
  const message = () => git("log", "-1", "--format=%B");
  return { directory, repo, shim, git, run, message };
}

function hasOneTrailer(message, author = identity) {
  assert.equal(message.split(`Co-authored-by: ${author}`).length - 1, 1, message);
}

test("agent commit keeps primary identity; manual commits remain untouched", (t) => {
  const { run, git, message } = fixture(t);
  run("git commit --allow-empty -m 'Agent change'");
  hasOneTrailer(message());
  assert.equal(git("log", "-1", "--format=%an <%ae>|%cn <%ce>"), "Fixture User <fixture@example.invalid>|Fixture User <fixture@example.invalid>");
  git("commit", "--allow-empty", "-m", "Manual change");
  assert.equal(message(), "Manual change");
});

test("message file, stdin, multiline/heredoc messages, and -C are supported", (t) => {
  const { repo, run, message } = fixture(t);
  writeFileSync(join(repo, "message.txt"), "From file\n\nDetailed body.\n");
  run(`git -C ${shellQuote(repo)} -c core.quotePath=false commit --allow-empty -F message.txt`);
  assert.ok(message().startsWith("From file\n\nDetailed body.")); hasOneTrailer(message());
  run("git commit --allow-empty -F - <<'MSG'\nFrom stdin\n\nA body with $literal text\nMSG");
  assert.ok(message().includes("$literal text")); hasOneTrailer(message());
  run("git commit --allow-empty -m \"$(printf 'Multiline\\n\\nBody')\"");
  assert.ok(message().startsWith("Multiline\n\nBody")); hasOneTrailer(message());
});

test("duplicates are suppressed and other co-authors preserved", (t) => {
  const { run, message } = fixture(t);
  run(`git commit --allow-empty -m ${shellQuote(`Already attributed\n\nCo-authored-by: Human <human@example.invalid>\nCo-authored-by: ${identity}`)}`);
  hasOneTrailer(message());
  assert.ok(message().includes("Co-authored-by: Human <human@example.invalid>"));
  run("git commit --amend --no-edit --allow-empty"); hasOneTrailer(message());
  const other = "GPT-5.4 <noreply@openai.com>";
  run("git commit --amend --no-edit --allow-empty", other);
  hasOneTrailer(message(), other); hasOneTrailer(message());
});

test("scripts and multiple repositories/commits inherit attribution", (t) => {
  const { repo, directory, run, git } = fixture(t);
  writeFileSync(join(repo, "commit.sh"), "#!/bin/sh\ngit commit --allow-empty -m 'From script'\n");
  run("sh commit.sh && git commit --allow-empty -m 'Second commit'");
  for (const body of git("log", "--format=%B%x00").split("\0").filter((s) => s.trim())) hasOneTrailer(body);
  const second = join(directory, "second"); mkdirSync(second);
  initialize(second);
  run(`cd ${shellQuote(second)} && git -c user.name=Fixture -c user.email=fixture@example.invalid -c commit.gpgSign=false commit --allow-empty -m 'Another repo'`);
  const body = execFileSync("git", ["-C", second, "log", "-1", "--format=%B"], { env: baseEnv, encoding: "utf8" });
  hasOneTrailer(body);
});

test("existing hooks are not replaced and receive the attributed message", (t) => {
  const { repo, run, git, message } = fixture(t);
  const hooks = join(repo, "custom-hooks"); mkdirSync(hooks);
  git("config", "core.hooksPath", hooks);
  writeFileSync(join(hooks, "commit-msg"), "#!/bin/sh\ngrep -q '^Co-authored-by:' \"$1\" || exit 9\nprintf '\\nhook ran\\n' >> hook.log\n", { mode: 0o700 });
  run("git commit --allow-empty -m 'Hooks work'"); hasOneTrailer(message());
  assert.ok(readFileSync(join(repo, "hook.log"), "utf8").includes("hook ran"));
  assert.equal(git("config", "core.hooksPath"), hooks);
  run("git commit --allow-empty --no-verify -m 'Skip hook'"); hasOneTrailer(message());
  assert.equal(readFileSync(join(repo, "hook.log"), "utf8").match(/hook ran/g).length, 1);
});

test("SSH-signed commits include attribution in a verifiable signature", (t) => {
  const available = spawnSync("ssh-keygen", ["-V"], { stdio: "ignore" });
  if (available.error) { t.skip("ssh-keygen is not installed"); return; }
  const { directory, run, git, message } = fixture(t);
  const key = join(directory, "signing-key");
  execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", key], { stdio: "pipe" });
  const signers = join(directory, "allowed-signers");
  writeFileSync(signers, `fixture@example.invalid ${readFileSync(`${key}.pub`, "utf8")}`);
  git("config", "gpg.format", "ssh");
  git("config", "user.signingKey", key);
  git("config", "gpg.ssh.allowedSignersFile", signers);
  git("config", "commit.gpgSign", "true");
  run("git commit --allow-empty -m 'Signed attribution'");
  hasOneTrailer(message());
  assert.ok(git("cat-file", "-p", "HEAD").includes("gpgsig -----BEGIN SSH SIGNATURE-----"));
  git("verify-commit", "HEAD");
});

test("failed commits and dry runs do not create or amend commits", (t) => {
  const { repo, shim, run, git } = fixture(t);
  run("git commit --allow-empty -m Initial");
  const head = git("rev-parse", "HEAD");
  const config = readFileSync(join(repo, ".git/config"), "utf8");
  const result = spawnSync("bash", ["-c", wrapCommand("git commit -m 'Nothing staged'", shim, identity)], { cwd: repo, env: baseEnv, encoding: "utf8" });
  assert.notEqual(result.status, 0);
  writeFileSync(join(repo, "staged.txt"), "A staged change\n");
  git("add", "staged.txt");
  run("git commit --dry-run -m 'Dry run'");
  assert.equal(git("rev-parse", "HEAD"), head);
  assert.equal(readFileSync(join(repo, ".git/config"), "utf8"), config);
});

test("pathspecs, options, and an explicit author are preserved", (t) => {
  const { repo, run, git, message } = fixture(t);
  writeFileSync(join(repo, "--file"), "content\n");
  run("git add -- --file && git commit --author='Another Human <human@example.invalid>' -m 'Pathspec' -- --file");
  hasOneTrailer(message());
  assert.equal(git("log", "-1", "--format=%an <%ae>"), "Another Human <human@example.invalid>");
});

test("Git wrapper from the existing PATH remains in the execution chain", (t) => {
  const { directory, run, message } = fixture(t);
  const realGit = execFileSync("bash", ["-c", "type -P git"], { env: baseEnv, encoding: "utf8" }).trim();
  const wrapper = join(directory, "existing-wrapper"); mkdirSync(wrapper);
  const log = join(directory, "wrapper.log");
  writeFileSync(join(wrapper, "git"), `#!/bin/sh\nprintf 'called\\n' >> ${shellQuote(log)}\nexec ${shellQuote(resolve(realGit))} "$@"\n`, { mode: 0o700 });
  run("git status --short && git commit --allow-empty -m 'Through wrapper'", identity, { PATH: `${wrapper}:${baseEnv.PATH}` });
  assert.equal(readFileSync(log, "utf8"), "called\ncalled\n"); hasOneTrailer(message());
});

test("co-author shell metacharacters are treated as text, not commands", (t) => {
  const { run, message, directory } = fixture(t);
  const author = `AI's $(touch ${join(directory, "unexpected")}) <ai@example.invalid>`;
  run("git commit --allow-empty -m 'Quotes' # trailing comment", author);
  hasOneTrailer(message(), author);
  assert.throws(() => readFileSync(join(directory, "unexpected")));
});
