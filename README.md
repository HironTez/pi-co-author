# pi-co-author

Automatically add the model that made a Pi agent commit as a Git co-author:

```text
Implement the feature

Co-authored-by: Claude Sonnet 4.6 <noreply@anthropic.com>
```

Your primary Git author and committer remain unchanged. Attribution is applied mechanically, not by asking the model to remember a prompt instruction.

## Install

From this directory:

```sh
pi install /absolute/path/to/pi-co-author
```

Or try it for a single session:

```sh
pi -e ./extensions/co-author.ts
```

Use `/reload` in **each existing session** after installing, including sessions in other projects. Merely creating this package directory does not activate it: it must be installed or explicitly loaded with `-e`.

Run `/co-author status` to confirm it is loaded and enabled. An unknown-command response means the extension is not loaded in that session. `pi list` should show the local package after installation. Attribution applies only to subsequent commits; installation does not change existing history.

Requires Pi's mutable `tool_call` API (`@earendil-works/pi-coding-agent` 1.1.0), Node.js 22.18+, Git 2.32+ (`git commit --trailer`), and a POSIX host (Linux/macOS).

## Behavior

- Intercepts agent `bash` calls, including nested Bash calls through `ctx.executeTool()` (e.g. codemode).
- A private, temporary `git` executable on the call's PATH adds Git's native `--trailer` option to explicit `git commit` invocations.
- Resolves the existing Git executable through the original PATH, preserving your Git wrappers and authentication/clone guardrails.
- Supports `cd`, `git -C`, multiple repositories, child scripts, multiple commits in one call, `-m`, `-F`, stdin, explicit `--author`, `--amend`, and `--no-verify`.
- Adds attribution **before signing**, so signatures cover the trailer. Existing hooks still run normally.
- Suppresses duplicate matching trailers while preserving other co-authors. An amend by a different model adds that model without removing the previous attribution.
- Uses the model recorded on the assistant message that emitted the tool call, including physical models selected by virtual routers. Model switches take effect on the next assistant message; parallel calls retain their own identity snapshot.
- Never installs repository hooks, edits Git configuration, or amends commits after the fact. Temporary files are removed on orderly session shutdown (a hard process kill may leave a directory in your system temp directory).
- Does **not** attribute your manual `!` / `!!` commands or commits outside Pi. Merely loading the extension never creates a commit.

Existing commit hooks and editors can intentionally change/remove trailers; this extension does not bypass them. Duplicate suppression applies to Git-recognized trailer blocks, not matching text elsewhere in a message. Custom `trailer.separators`, competing trailer-key aliases, and dynamic `trailer.*.cmd` / `.command` configuration can affect formatting or attribution; these advanced configurations are not normalized by the extension.

## Identity and controls

The co-author name is the model's catalog display name (or model ID when unavailable). Recognized Claude, OpenAI GPT/o-series, and Gemini models use `noreply@anthropic.com`, `noreply@openai.com`, and `noreply@google.com`. Other models use a provider/model-derived address at the reserved `models.invalid` domain. These are attribution conventions, **not** verified vendor/GitHub accounts.

Set explicit identity overrides if you need your own bot/account address:

```sh
PI_CO_AUTHOR_NAME='My AI Assistant' PI_CO_AUTHOR_EMAIL='bot@example.com' pi
```

Control attribution inside Pi:

```text
/co-author          # status and current selected model's attribution
/co-author off      # disable
/co-author on       # enable
```

Toggles last for the current extension runtime and reset on reload/restart. Start disabled with `PI_CO_AUTHOR_ENABLED=0 pi`. Overrides apply to every model. Invalid overrides block attribution rather than allowing forged multiline trailers.

## Scope and limitations

This is workflow automation, not a security boundary or universal Git monitor. It covers **explicit `git commit` commands resolved through PATH in local agent Bash calls**. It does not cover:

- Absolute Git paths such as `/usr/bin/git`, an existing shell function named `git`, scripts that reset PATH, or cleared environments (`env -i`).
- Git subcommand aliases (`git ci`), unknown future Git global options, `commit-tree`, commits synthesized by merge/rebase/cherry-pick/am, or commits created internally by other tools.
- Remote/container execution, PowerShell, custom commit tools, or extension code calling `pi.exec()` directly. Do not use this with a remote replacement for Pi's local Bash tool.
- Child background jobs that outlive session shutdown.

Standard shell aliases that expand to `git commit` are supported when alias expansion is enabled. Prefer explicit `git commit` when attribution matters. `--fixup` and `--squash` follow Git's native message rules; later autosquash/rebase can discard or rewrite trailers, so inspect the final history.

## Development

```sh
npm install
npm run check
```

Tests use disposable local repositories with synthetic identities and no remotes. They cover trailer handling, message formats, existing hooks/wrappers, failures, manual commits, SSH signing, and extension lifecycle/model tracking. No model/API calls are needed. The signing test requires `ssh-keygen` and is skipped if unavailable.

To explicitly use a Git binary for disposable repository initialization only:

```sh
PI_CO_AUTHOR_TEST_GIT=/usr/bin/git npm run check
```

This override never changes the extension's runtime behavior: agent commands still resolve Git through PATH, and the tests still verify wrapper preservation. It does not alter machine-wide Git settings or guardrails.

If your machine requires account-aware repository initialization through `git-gh-account`, choose an account explicitly:

```sh
PI_CO_AUTHOR_TEST_GH_ACCOUNT=your-login npm run check
```

The account option uses `git-gh-account init` for test fixtures without bypassing the Git wrapper. The explicit binary option takes precedence if both are set. That helper may query GitHub for the account's public identity, but tests override commit identities with synthetic ones and never clone or push.
