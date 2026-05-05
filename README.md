# Congrex AI Senate (v1.0.5)

Congrex turns one prompt into a structured debate between multiple AI models, then promotes the strongest answer into an optional supervised execution round when implementation is actually needed.

It is built for code and technical decision-making where a single model answer is often not enough. Congrex lets a chamber of models answer, critique, and vote, uses a mandatory Senate President to break ties, and keeps any file edits or terminal commands behind explicit human approval.

## Why Use It

- Compare multiple model answers on the same prompt instead of trusting one response.
- Force a final chamber decision with a designated Senate President for tie-breaking.
- Keep implementation optional: advice can stay advice, and code changes only happen in a supervised execution round.
- Resume saved sessions, restore the last consensus/winner context, and continue with `/implement` when you are ready.
- Stay local-first: senators, sessions, presets, and MCP configuration live on your machine.
- Use defense-in-depth guardrails around file edits, command execution, MCP tools, and terminal output.

## Example Use Case

You ask Congrex how to simplify a TypeScript build pipeline in an existing repo. Several models propose different approaches, critique each other, and vote. Congrex shows the winning answer first. If that answer clearly calls for code changes, Congrex can enter the execution round, propose the exact file edits and commands, and wait for your approval before anything runs.

## Requirements

- Node.js `>=20`
- Rust toolchain (`cargo`) for building the local `congrex-executor` binary during installation
- API keys for any hosted providers you want to use, including OpenAI, Anthropic, Google, xAI, or OpenRouter
- Optional local inference endpoint such as Ollama or LM Studio for `local` senators
- At least 2 active senators and 1 designated Senate President before any debate can start

## Providers

Congrex supports these provider paths:

- `OpenAI`, `Anthropic`, `Google`, and `xAI` as hosted providers with built-in defaults.
- `OpenRouter` as a first-class hosted provider with a built-in base URL.
- `Custom (OpenAI-compatible, advanced)` for manual OpenAI-compatible endpoints and base URLs.
- `Local AI (Ollama/LM Studio)` for Ollama, LM Studio, and similar local OpenAI-compatible servers.

### Provider setup

- `OpenRouter`: choose `OpenRouter`, set `OPENROUTER_API_KEY` or configure an env var in Congrex, and enter the model ID you want to use. Normal setup does not ask for the OpenRouter base URL.
- `Custom (OpenAI-compatible, advanced)`: use this when you need to point Congrex at a manual hosted endpoint. You provide the model ID and the provider's OpenAI-compatible base URL.
- `Local AI (Ollama/LM Studio)`: use this for local inference servers. You provide the local model name and local base URL.

Example OpenRouter setup:

```bash
export OPENROUTER_API_KEY=your_key_here
congrex
```

Then choose `OpenRouter` in the provider picker and enter the model ID you want to route through OpenRouter.

## Installation

### Local development

```bash
npm install
npm run build
```

Run the development entrypoint with:

```bash
npm run dev
```

Run the built CLI with:

```bash
node dist/index.js
```

### Global installation

Install Congrex globally with:

```bash
npm install -g congrex
```

This installs the `congrex` command and runs a postinstall step that ensures the Rust executor is available. If the executor binary is not already present, Congrex runs:

```bash
cargo build --release
```

inside the bundled `congrex-executor` folder.

If Rust is not installed yet, install it first from [rustup.rs](https://rustup.rs/) and then re-run:

```bash
npm install -g congrex
```

For docs-only or development installs where you do not plan to run Congrex yet, you can skip the executor build explicitly:

```bash
CONGREX_SKIP_EXECUTOR_BUILD=1 npm install
```

That leaves the package without a working executor. Execution rounds will not work until you build `congrex-executor` or set `CONGREX_EXECUTOR_BIN` to a valid executor binary.

After a global install, start the CLI with:

```bash
congrex
```

## First Run

1. Start Congrex with `congrex`, `node dist/index.js`, or `npm run dev`.
2. If you have fewer than 2 active senators, Congrex automatically opens setup and makes you add enough senators to begin.
3. As soon as the chamber has 2 active senators, Congrex requires you to choose a Senate President (`/boss`) before any debate can start.
4. The Senate President is mandatory because it resolves tie votes and guarantees a final chamber decision.
5. Enter a prompt for the Senate to debate.
6. Review the winning answer first.
7. Congrex then runs a conservative Judge step on the winning answer.
8. If the Judge detects clear implementation intent, Congrex enters the execution round automatically. Otherwise the turn ends with no tool calls.
9. You can always use `/implement` later to force the execution round on the last winner answer.

> Warning  
> Keep the roster lean. More than 4 active senators is supported, but debates get noticeably slower and substantially more expensive in tokens.

## TTY Commands

- `/add` configure a new senator.
- `/edit` update an existing senator.
- `/remove` remove a senator from the roster.
- `/boss` designate or change the mandatory Senate President required before debates can run. `/president` is an alias.
- `/mcp` manage MCP tool servers.
- `/preset` switch active senator rosters.
- `/new` start a fresh session.
- `/resume` resume a previous session.
- `/copy` copy the latest consensus output to the clipboard.
- `/implement` force the execution round on the last winner answer. You can append extra instructions, for example `/implement add tests`.
- `/update` update Congrex globally with `npm install -g congrex@latest`, then exit.
- `/clear` clear the terminal screen.
- `/wipe` remove all senators. `/reset` is an alias.
- `/exit` quit Congrex. `/quit` is an alias.

Congrex requires at least 2 active senators and 1 active Senate President before a debate can run. If the President is missing, Congrex stops and asks you to choose one immediately.

Congrex does not impose a hard upper limit on active senators. More than 4 active senators is allowed, but it is strongly discouraged unless you explicitly want slower, more expensive debates.

On startup, Congrex also performs a silent npm version check using `update-notifier`. If a newer package version is known, it shows a small non-blocking upgrade hint. Set `NO_UPDATE_NOTIFIER=1` to disable that check.

When you resume a session, Congrex restores the saved debate history, the last consensus output, and the last winning senator context. That means you can use `/implement` immediately after `/resume` without rerunning the debate first. If the current active chamber or Senate President no longer matches the saved session, Congrex warns you before the next debate continues with the current chamber.

## Execution Model

Congrex separates deliberation from execution.

### Debate flow

Each turn runs through a structured chamber process:

1. Senators answer the prompt independently.
2. Senators critique each other.
3. Senators vote on the strongest answer.
4. The Senate President breaks ties when needed and guarantees a final winner.

After the debate, Congrex always shows the winning answer first.

### Judge step

Congrex then runs a conservative Judge step on the winning answer. The goal is simple: if the answer is informational, comparative, or advisory, the turn ends normally. If the answer clearly implies code changes on the local machine, Congrex can move into the execution round.

### Execution round

When execution starts, the winning model can use two native tools:

- `edit_file` — exact search-and-replace against local files
- `execute_command` — terminal commands in argv-form, without shell strings

The execution round is still supervised. Congrex validates the proposed operation, shows it to you, and requires explicit approval before running any file write or terminal command.

## Security and Privacy

Congrex treats every LLM as untrusted. The security model is defense-in-depth: multiple independent layers must all pass before any action reaches your system.

### API key storage

Congrex supports three credential sources. At runtime it resolves them in this order:

1. **`apiKeyEnvVar`** — a custom environment variable name stored per senator in `senators.json`. Congrex stores only the variable name, never the resolved secret value, and reads the key from the environment at runtime.
2. **`apiKey`** — stored directly in `~/.config/congrex/senators.json`. The file is created with mode `0o600` (owner-only read/write), but the key itself is plaintext on disk.
3. **Provider environment variables** — `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GOOGLE_API_KEY` / `GEMINI_API_KEY`, `XAI_API_KEY`, `OPENROUTER_API_KEY`. These are used when no senator-specific source resolves to a key.

If both `apiKeyEnvVar` and `apiKey` are present, Congrex checks the custom environment variable first, then falls back to the stored `apiKey`, and finally to the provider default environment variable.

Recommendation: prefer provider environment variables or `apiKeyEnvVar`. Use a literal `apiKey` only when you explicitly want local plaintext storage.

### MCP environment isolation

MCP server commands configured in `~/.config/congrex/config.json` are executed as local child processes during startup. The MCP tool approval gate controls which discovered tools are exposed to LLMs; it does not approve or sandbox the configured server process itself. Only configure MCP servers you trust to run on your machine.

MCP servers run as child processes. They receive a sanitized environment containing only the system variables needed to function, such as PATH, HOME, locale, TLS certificates, language runtime paths, and proxy settings. API keys, database URLs, cloud credentials, and other secrets from the parent process are not forwarded by default.

Operators can pass additional specific env vars per server via the `env` field in `config.json`. Those variables are explicitly chosen and trusted.

### MCP tool approval gate

On startup, and again after any MCP server add/remove, Congrex shows which MCP tools passed the safety filter and requires explicit human approval before those tools become available during debates:

- **Approve all** — enables all filtered tools with per-call logging.
- **Select** — choose specific tools to approve.
- **Disable** — no MCP tools for this session.

Every approved MCP tool call is logged to the terminal for transparency.

MCP tools are only exposed during debate when every participating senator uses a local provider. If any active senator uses a hosted provider such as OpenAI, Anthropic, Google, xAI, OpenRouter, or a custom hosted OpenAI-compatible endpoint, Congrex disables MCP tools for that debate to avoid forwarding tool definitions or tool results to third-party APIs.

### MCP tool filtering

Tools go through a two-layer safety filter before they are offered for approval:

1. **Name token blocklist** — tool names are tokenized across `camelCase`, `snake_case`, and `kebab-case`. If any token matches blocked mutation, deletion, execution, or external-side-effect verbs, the tool is rejected.
2. **Description pattern scan** — tool descriptions are checked against patterns that detect mutation, deletion, command execution, or external communication. This catches tools with harmless-looking names but dangerous purposes.

Both layers must pass. Per-server `allowTools` / `denyTools` overrides in `config.json` provide fine-grained control.

### MCP timeouts and limits

| Operation | Timeout |
|---|---|
| Server connection | 15 seconds |
| Tool listing | 10 seconds |
| Tool call | 30 seconds |

Tool call results are truncated to 64 KB to protect LLM context windows.

### File and command guardrails

Before any write, `edit_file`:

- rejects hidden control, ANSI, and BiDi characters,
- rejects empty replacement anchors,
- rejects non-unique matches,
- resolves real paths and blocks symlink escapes,
- shows the proposed edit for review,
- requires explicit user approval.

Commands are validated by two independent denylist layers, one in TypeScript and one in the Rust executor, before reaching the human approval gate.

Blocked categories include:

| Category | Blocked programs |
|---|---|
| Privilege escalation | `sudo`, `su`, `doas`, `pkexec`, `runas` |
| Interactive shells | `bash`, `sh`, `zsh`, `fish`, `cmd`, `powershell`, etc. |
| Remote access / exfiltration | `ssh`, `scp`, `curl`, `wget`, `nc`, `netcat`, `rsync`, etc. |
| System management | `dd`, `mkfs`, `systemctl`, `shutdown`, `reboot`, etc. |
| Container / VM | `docker`, `podman`, `kubectl`, `vagrant` |
| macOS automation | `osascript`, `automator` |
| Package managers | `apt`, `brew`, `pip`, `cargo`, `go`, `gem`, etc. |
| Credential access | `security`, `keychain`, `gpg`, `pass` |
| Compilers | `gcc`, `clang`, `cc`, etc. |

Additionally:

- Interpreter inline eval flags (`-c`, `-e`, `-p`, `--eval`) are blocked for `python`, `node`, `ruby`, `perl`, and similar runtimes.
- Shell operators (`|`, `;`, `&`, `` ` ``, `$`, `>`) in arguments are rejected.
- Destructive git subcommands (`push`, `clean`, `reset`, `rebase`, `merge`, `rm`, etc.) are blocked.
- `find` with `-delete` or `-exec` actions is blocked.
- `rm` with both recursive and force flags is blocked.
- Programs like `npm`, `git`, and `make` that pass the denylist show an elevated warning.

After both denylist layers pass, Congrex displays the full command, working directory, and timeout, then requires explicit user approval.

### Diagnostics

The MCP manager maintains a rolling audit log of the last 200 tool invocations, including timestamps, durations, result sizes, and errors, plus per-server health metrics available through `getServerHealth()` and `getRecentAudit()`. Approved MCP calls are also echoed to the terminal as they happen.

### Privacy

Congrex is local-first. Senator definitions, sessions, presets, and configuration stay on your machine in `~/.config/congrex/`. The CLI talks directly to the providers and MCP servers you configure. There is no hosted Congrex backend.

## Maintainability Roadmap

The current implementation keeps the CLI in a small number of files. Future low-risk extraction boundaries are:

- provider clients and response parsing from `src/index.ts`,
- CLI command routing and interactive prompts from `src/index.ts`,
- execution approval helpers from `src/index.ts`,
- MCP approval/session glue from `src/index.ts`,
- session persistence remains in `src/config.ts`,
- Rust executor command policy, file replacement, and process containment can be split from `congrex-executor/src/main.rs` after behavior-preserving tests are in place.
