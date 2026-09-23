# LiteLLM Setup Guide

> **Language / 언어:** English | [한국어](LITELLM_KO.md)

This document covers putting **this repository's bridge behind a LiteLLM proxy**, so that
LiteLLM clients reach GitHub Copilot models through `src/server.mjs`. If you only need
Claude Code talking to the bridge, follow the
[README](../README.md#direct-sdk-quick-start) instead — LiteLLM adds a hop, not a
capability.

## Topology

```text
Direct:  Claude Code -> bridge (src/server.mjs) -> @github/copilot-sdk -> Copilot model
LiteLLM: any client  -> LiteLLM -> bridge (src/server.mjs) -> @github/copilot-sdk -> Copilot model
```

LiteLLM is configured with its `anthropic/*` provider and an `api_base` pointing at the
bridge root. This is **not** LiteLLM's own `github_copilot/*` provider. That provider runs
its own GitHub device-OAuth flow, keeps its own credentials under
`~/.config/litellm/github_copilot`, and never touches this repository or
`@github/copilot-sdk`. Nothing on this page uses it.

The reason to add the hop: LiteLLM gives you virtual keys, budgets, request logging and an
OpenAI-shaped surface in front of a bridge that speaks only the Anthropic Messages API, to
one loopback caller, with one credential.

## Verification Scope

LiteLLM is outside this repository's verification scope. The `npm run verify` matrix (6 models x 11 scenarios = 66 slots) starts `src/server.mjs` directly and never starts LiteLLM, so nothing on this page is covered by it — treat this as a configuration reference, not a validated path.

Everything below about LiteLLM's own wire behaviour is written against the `v1.97.0` that
`npm run litellm:setup` **pins** (commit `ef84494`, `scripts/setup-litellm.sh`) — a pin, not
a test result. A different LiteLLM release may append a different path, forward a different
header set, or reject a different model string. Claims about `src/` are a different matter:
those are read off this repository's source and cited by file. See
[Validation Scope](ARCHITECTURE.md#validation-scope) for what is covered.

## What the Bridge Exposes

The `api_base` you give LiteLLM has to line up with a very small surface, all of it in
`src/server.mjs`:

| Method and path | Auth | Notes |
|---|---|---|
| `POST /v1/messages` | required | The only inference route |
| `POST /v1/messages/count_tokens` | required | LiteLLM never calls it — see Known Constraints |
| `GET /health` | none | Safe for liveness probes |
| `HEAD /api/hello` | none | Answered before the auth gate; `200` with an empty body |
| `GET /v1/models` | required | Model catalogue |
| anything else | required | `404` with `not_found_error` — but the auth gate runs first, so a bad credential gets `401` instead |

Authentication accepts **either** `Authorization: Bearer <token>` **or**
`x-api-key: <token>`. The bridge binds to loopback only, unless `ALLOW_NON_LOOPBACK=1` is
set.

## Prerequisites

- macOS or Linux
- Bash, `curl`, Git
- Node.js `^20.19.0` or `>=22.12.0`
- `uv` and Python 3.13, for a local LiteLLM
- A working Copilot CLI login (`copilot login`) for the bridge itself

```bash
git clone https://github.com/junwoojeong100/claude-code-ghcp-sdk.git
cd claude-code-ghcp-sdk
npm install
```

All commands below run from the repository root.

## 1. Start the Persistent Bridge

`bin/claude-ghcp` starts an ephemeral bridge that dies with Claude Code. LiteLLM needs a
base URL and a token that outlive a single run, so use the daemon instead, and **pin the
port** — an unpinned daemon picks a free one:

```bash
export GHCP_BRIDGE_PORT=4142
node src/bridge-daemon.mjs ensure claude-sonnet-5 "$GHCP_BRIDGE_PORT"
```

`ensure` prints the whole registry as JSON on stdout:

```json
{"createdAt":"...","configFingerprint":"...","instanceId":"...","model":"claude-sonnet-5","pid":12345,"port":4142,"token":"<48-hex-characters>","version":1,"logPath":"...","settingsPath":"..."}
```

Only `port` and `token` matter here. `logPath` is where the daemon writes its log;
`settingsPath` is a fresh per-launch Claude Code settings file that `ensure` allocates on
every call and that a LiteLLM operator should ignore.

Export the two values LiteLLM needs. Note the **absence of `/v1`** in the URL:

```bash
export GHCP_BRIDGE_URL="http://127.0.0.1:$GHCP_BRIDGE_PORT"

# Capture the registry, then parse it. `ensure` reports failure on stderr and exits
# non-zero leaving stdout empty, so piping it straight into the parser would bury the
# real message under `SyntaxError: Unexpected end of JSON input`.
GHCP_REGISTRY="$(node src/bridge-daemon.mjs ensure claude-sonnet-5 "$GHCP_BRIDGE_PORT")"
if [ -n "$GHCP_REGISTRY" ]; then
  export GHCP_BRIDGE_TOKEN="$(printf '%s' "$GHCP_REGISTRY" \
    | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>process.stdout.write(JSON.parse(d).token))')"
else
  # Fail closed. A token exported by an earlier run survives this failure and now
  # names a bridge that is gone; every downstream check is a non-empty test, so a
  # stale value would pass all of them.
  unset GHCP_BRIDGE_TOKEN
  echo "ensure failed; its message is above. GHCP_BRIDGE_TOKEN is now unset." >&2
  false
fi
```

The `else` branch does three things and each one matters. It **unsets**
`GHCP_BRIDGE_TOKEN` rather than leaving it alone: a token exported by an earlier run
survives a failed `ensure` and now names a bridge that is gone, and every downstream
check — including the one in
[`../scripts/start-litellm.sh`](../scripts/start-litellm.sh) — only tests that the
variable is non-empty. A surviving stale token therefore starts a gateway that boots
cleanly and fails on the first request instead of at startup. It writes the reminder to
stderr. And it ends in `false`, so the whole `if` reports non-zero and a script running
this under `set -e` stops here. It deliberately does not call `exit`, which would close
the shell when the block is pasted interactively and would abort the caller when the
block is sourced.

The success branch needs no such guard: if `ensure` printed something that is not
registry JSON, the parser exits non-zero with empty stdout and
`export GHCP_BRIDGE_TOKEN=""` overwrites the old value with an empty one, which the same
non-empty checks then reject.

Confirm the bridge is up before configuring anything else:

```bash
curl --silent --show-error --fail "$GHCP_BRIDGE_URL/health"

curl --silent --show-error --fail \
  -H "x-api-key: $GHCP_BRIDGE_TOKEN" \
  "$GHCP_BRIDGE_URL/v1/models"
```

### Recovering the token later

`./bin/claude-ghcp-status` deliberately prints only `{model, pid, port, running}` — never
the token. To recover one, either re-run `ensure` or read the registry file.

`ensure` returns the existing registry when the daemon is healthy and its fingerprint still
matches — but on that same path it first calls `modelAvailable()` and throws
`GitHub Copilot model is unavailable: <model>` when the model you named is absent from the
daemon's `/v1/models?all=true` (`src/bridge-daemon.mjs`). A run whose only purpose was to
recover the token can therefore fail outright. Reading the file has no such failure mode:

| Location | Path |
|---|---|
| `GHCP_DAEMON_DIR` is set | `$GHCP_DAEMON_DIR/bridge.json` |
| macOS default | `~/Library/Caches/claude-code-ghcp-sdk/bridge.json` |
| Linux default | `${XDG_CACHE_HOME:-~/.cache}/claude-code-ghcp-sdk/bridge.json` |

The directory is `0700` and the registry file is `0600`. Treat the token like a password:
it grants a caller your GitHub Copilot seat. Stop the daemon with `./bin/claude-ghcp-stop`.

### The `GHCP_BRIDGE_PORT` trap

`bin/claude-ghcp` reads `GHCP_BRIDGE_PORT` into its bridge port, but it only picks a free
port by itself in ephemeral mode. In persistent mode — `--background`, `--bg`, or the
`agents` subcommand — an unset `GHCP_BRIDGE_PORT` means it calls `ensure` with **no**
requested port.

The requested port is part of the daemon's configuration fingerprint
(`daemonConfigFingerprint` in `src/bridge-daemon.mjs`). So if you ran
`ensure claude-sonnet-5 4142` for LiteLLM and then run `claude-ghcp --background` in
another shell without the variable, the fingerprints disagree: the launcher stops your
daemon, starts a new one on a new random port with a **new token**, and LiteLLM gets
connection refused on `4142`.

Export `GHCP_BRIDGE_PORT=4142` in **both** shells — before `ensure`, and before the
launcher — and the fingerprints match.

### The daemon inherits its launch directory

`ensureDaemon` spawns `src/server.mjs` with no `cwd` option, so the daemon inherits the
working directory of whoever ran `ensure`. That directory is *not* the Copilot data
directory: `src/session-manager.mjs` constructs its `CopilotClient` with only `mode`,
`baseDirectory` and `logLevel`, and `baseDirectory` is
`resolveCopilotHome(process.env.COPILOT_HOME)` — `~/.copilot` by default, never the cwd.
Nor does `sessionOptions` set a `workingDirectory`, which per `@github/copilot-sdk`'s
`types.d.ts` leaves the runtime process inheriting the caller's cwd. So the inherited
directory follows the daemon for its whole life; start `ensure` somewhere that will outlive
it.

Whatever the SDK raises when a session cannot be constructed, `src/server.mjs` forwards
`error.message` verbatim and prefixes nothing of its own: a `500` carrying
`type: "api_error"` for a non-streaming request, an `event: error` frame carrying the same
`api_error` for a streaming one (`writeSseError` in `src/anthropic.mjs`). Read the message
itself rather than matching on a fixed string. If the launch directory is the problem, run
`./bin/claude-ghcp-stop` and re-run `ensure` from a directory that still exists.

## 2. Bridge Backend Mapping

The example configuration is in
[`../examples/litellm-github-copilot.yaml`](../examples/litellm-github-copilot.yaml):

```yaml
model_list:
  - model_name: claude-sonnet-5
    litellm_params:
      model: anthropic/claude-sonnet-5
      api_base: os.environ/GHCP_BRIDGE_URL      # bridge root, no /v1
      api_key: os.environ/GHCP_BRIDGE_TOKEN

general_settings:
  master_key: os.environ/LITELLM_MASTER_KEY
  forward_client_headers_to_llm_api: true
```

| Field | What it does | Why it is written this way |
|---|---|---|
| `model_name` | The alias clients ask for | Free-form. It is what `LITELLM_MODEL` and `--litellm-model` must match, and what `/v1/models` on LiteLLM returns |
| `model: anthropic/<id>` | Selects LiteLLM's Anthropic provider | Everything after `anthropic/` is sent verbatim as the upstream request body's `model`, so it must be an ID the bridge resolves |
| `api_base` | Upstream base URL | LiteLLM appends `/v1/messages` itself, so this is the bridge root with **no path** |
| `api_key` | Upstream credential | Sent as the `x-api-key` header, which the bridge accepts |
| `forward_client_headers_to_llm_api: true` | Passes client `x-*` headers upstream | The bridge needs `x-claude-code-session-id` and `x-claude-code-agent-id` to keep one Copilot SDK session per Claude session and per subagent. Without it every request collapses into one anonymous session family |

The repository's example file exposes an alias per model in the primary matrix — the six
in `PRIMARY_MODELS` (`src/model-map.mjs`, re-exported by `scripts/verify/scenarios.mjs`):
`claude-opus-5.5`, `claude-sonnet-5`, `claude-haiku-4.5`, `gpt-6-astra`, `gpt-6-sol`,
`gpt-6-luna`. All six point at the same bridge.

### `api_base` must not end in `/v1`

LiteLLM appends `/v1/messages` to whatever `api_base` you give it:

| `api_base` | Request LiteLLM actually sends | Result |
|---|---|---|
| `http://127.0.0.1:4142` | `POST http://127.0.0.1:4142/v1/messages` | Correct |
| `http://127.0.0.1:4142/v1` | `POST http://127.0.0.1:4142/v1/v1/messages` | `404` `not_found_error` from the bridge — provided the credential is right; if it is not, the auth gate answers `401` first |

`scripts/start-litellm.sh` rejects a `GHCP_BRIDGE_URL` ending in `/v1` before LiteLLM
starts, so the mistake surfaces as a startup error rather than a runtime `404`.
(`LITELLM_ANTHROPIC_DISABLE_URL_SUFFIX=true` is the only reason to write a full
`/v1/messages` URL, and this page does not use it.)

### The `[1m]` context suffix

The bridge strips a `[1m]` or `[NNNk]` suffix before resolving a model
(`stripContextSuffix` in `src/model-map.mjs`), and the suffix never selects a larger
backend tier: Claude models stay on the SDK default tier, while GPT-6 (and GPT-5.6) models
use the long-context tier with or without it. An `anthropic/<id>[1m]` backend string is
therefore accepted but behaves exactly like `anthropic/<id>`. LiteLLM does no such
stripping, so a bracketed alias is one it cannot match and it rejects the request upstream
with a `400 Invalid model name` — LiteLLM behaviour this repository does not verify. Keep
the brackets out of `model_name` and out of `--litellm-model`.

Claude Code sizes its context window from the model name it is configured with, which on
this path is the bracket-free alias, so it keeps its default window.
`src/write-litellm-settings.mjs` sets no context override, and the Direct writer only
clears an inherited `CLAUDE_CODE_MAX_CONTEXT_TOKENS`. For a 1M window with GPT-6 Astra,
Sol or Luna, use the Direct path in the [README](../README.md#direct-sdk-quick-start):
its model-scoped `github-copilot/claude-<id>[1m]` launch and picker IDs carry the window.
Neither path offers a 1M window for the Claude rows.

## 3. Start LiteLLM

```bash
npm run litellm:setup   # once: LiteLLM v1.97.0 source, venv, FastAPI pin, master key
npm run litellm:start
```

`scripts/start-litellm.sh` refuses to start unless `GHCP_BRIDGE_URL` and
`GHCP_BRIDGE_TOKEN` are exported, because the YAML resolves both through `os.environ/` at
load time and LiteLLM would otherwise start with an unroutable model. Override the config
file with `LITELLM_CONFIG`, the bind address with `LITELLM_HOST`, and the port with
`LITELLM_PORT`.

Keep the terminal that prints `Application startup complete` running.

## 4. Point a Client at LiteLLM

For Claude Code, use the launcher in a second terminal:

```bash
export LITELLM_BASE_URL="http://127.0.0.1:4000"
export LITELLM_API_KEY="$(tr -d '\n' < .runtime/litellm-master-key)"
export LITELLM_MODEL="claude-sonnet-5"

./bin/claude-litellm
```

`LITELLM_MODEL` must match a `model_name` from the config, not the `anthropic/...` backend
string. `LITELLM_BASE_URL` must not end in `/v1` either — Claude Code appends
`/v1/messages` the same way LiteLLM does, and `src/write-litellm-settings.mjs` rejects it.
The launcher writes provider settings to a mode-`0600` temporary file and removes it when
Claude Code exits.

In a local single-user setup the master key doubles as the client key. On a shared
gateway, issue per-user virtual keys and never hand out the master key.

Check a remote gateway before launching:

```bash
curl --silent --show-error --fail \
  -H "Authorization: Bearer $LITELLM_API_KEY" \
  "$LITELLM_BASE_URL/health/liveliness"

curl --silent --show-error --fail \
  -H "Authorization: Bearer $LITELLM_API_KEY" \
  "$LITELLM_BASE_URL/v1/models"
```

Optional family aliases, if the gateway exposes more than one model:

```bash
export LITELLM_OPUS_MODEL="claude-opus-5.5"
export LITELLM_SONNET_MODEL="claude-sonnet-5"
export LITELLM_HAIKU_MODEL="claude-haiku-4.5"
```

Families without an alias fall back to `LITELLM_MODEL`.

## Known Constraints

- **The bridge is loopback-only** unless `ALLOW_NON_LOOPBACK=1` is set, so LiteLLM has to
  run on the same host. A remote shared gateway cannot reach it. Turning that flag on
  publishes one person's GitHub Copilot seat on a network port: every request LiteLLM
  forwards is billed to that seat and governed by that user's organization policy, whoever
  sent it. If several people need a gateway, run a bridge plus a LiteLLM per person, or use
  the Direct SDK path.
- **The token and port rotate.** `daemonConfigFingerprint` hashes the relevant environment
  variables, the clone's own absolute path (`implementation.update(rootDir)`),
  `package.json`, `package-lock.json`, every `src/*.mjs` file, and the requested port.
  Changing any of them makes `ensure` stop the old daemon and start a new one with a new
  random token — and a new port if unpinned. Editing anything under `src/` therefore
  invalidates the token LiteLLM is holding, and so does **moving or renaming the clone**,
  which changes nothing about the code but still rotates both values. Re-export `GHCP_BRIDGE_TOKEN` and restart
  LiteLLM after any daemon restart.
- **`count_tokens` never reaches the bridge.** LiteLLM answers
  `POST /v1/messages/count_tokens` itself with a local estimate, so the bridge's own
  `x-ghcp-token-count-method: estimated` route is unreachable behind LiteLLM. Expect the
  two numbers to disagree.
- **Model discovery is a Direct-path feature.** LiteLLM's `/v1/models` returns its own
  aliases. The bridge's gateway-discovery rows — `backend_id`, `display_name`,
  `capabilities` — are not forwarded, so the Claude Code model picker does not see them.
- **Cost tracking is wrong by construction.** Copilot model IDs are absent from LiteLLM's
  built-in cost map, so dashboard cost is zero or wrong. Reconcile against GitHub Copilot
  AI Credits, not the dashboard.
- **Sampling controls are ignored.** `temperature`, `top_p`, `max_tokens` and
  `stop_sequences` are not exposed by the Copilot SDK. `GET /health` reports them under
  `unsupportedNativeControls`; the bridge logs them as degraded controls and ignores them,
  whichever front end sends them. LiteLLM will happily accept and forward them.
- **Do not set `forward_llm_provider_auth_headers`.** That setting — a different one from
  `forward_client_headers_to_llm_api` — forwards a client's own `x-api-key` and overrides
  the configured bridge key.
- **The local setup pins FastAPI `0.139.0`.** `scripts/setup-litellm.sh` installs
  `litellm[proxy]` and then runs a second `pip install` that overwrites whatever FastAPI
  that resolved. The pin carries no rationale in the script, and this repository records no
  test of LiteLLM `v1.97.0` against any other FastAPI release, so the pinned pair is the
  only combination this page describes.

## Troubleshooting

### `404` `not_found_error` from the bridge

`api_base` has a path on it. It must be scheme, host and port only — LiteLLM appends
`/v1/messages`. Anything outside the five routes listed above gets a `404` — but only once
the request is authenticated: `src/server.mjs` runs the auth gate before the `404`
fallthrough, so an unknown path presented with a missing or wrong credential comes back as
`401` `authentication_error` instead.

### `Connection refused` from LiteLLM

The daemon is not listening on the port LiteLLM is configured for. The usual cause is the
`GHCP_BRIDGE_PORT` trap: a `claude-ghcp --background` run in another shell replaced your
pinned daemon with an unpinned one. Check with `./bin/claude-ghcp-status`, then re-run
`ensure` with the port exported in both shells.

### `401` from the bridge

- The daemon restarted and rotated the token. Re-run `ensure`, re-export
  `GHCP_BRIDGE_TOKEN`, and restart LiteLLM.
- `GHCP_BRIDGE_TOKEN` was not exported before LiteLLM started; `os.environ/` resolves at
  load time.

### `400 Invalid model name`

The requested model contains a `[1m]` or `[NNNk]` suffix. LiteLLM does no suffix stripping,
so this is a LiteLLM-side rejection, not the bridge's. Use a bracket-free `model_name` with
the suffix after `anthropic/`.

### `api_error` from the bridge

Which shape you get depends on whether the request was streaming, and LiteLLM streams, so
the streaming column is the one you will normally hit.

| Error raised in the request path | Non-streaming | Streaming |
|---|---|---|
| `BridgeRequestError`, `ModelUnavailableError`, `ReasoningEffortUnavailableError` | `400` `invalid_request_error` | `event: error` carrying `api_error` |
| anything else | `500` `api_error` | `event: error` carrying `api_error` |

On the non-streaming path `src/server.mjs` classifies the error, and those three types —
`BridgeRequestError` among them — become a `400` `invalid_request_error`; everything else
becomes a `500` `api_error`.

On the streaming path that classification never runs. `src/server.mjs` short-circuits to
`writeSseError` and returns before reaching it, and `writeSseError` in
`src/anthropic.mjs` hardcodes `type: "api_error"`. The HTTP status is already `200` from
the SSE preamble, so there is no `500` either: the failure arrives only as an
`event: error` frame. A rejected model name therefore reaches LiteLLM as `api_error`, not
as the `400` `invalid_request_error` the non-streaming path would have produced.

In both paths the `message` is the underlying error's own, forwarded verbatim — so read
the message rather than matching on the type or on a fixed string. One recurring cause
behind LiteLLM is a daemon whose launch directory has since been deleted; see
[The daemon inherits its launch directory](#the-daemon-inherits-its-launch-directory).

### Every conversation interferes with every other one

`forward_client_headers_to_llm_api` is missing or `false`, so `x-claude-code-session-id`
and `x-claude-code-agent-id` never reach the bridge and all callers share one session
family.

### `model not found`

- The alias must appear in LiteLLM's `/v1/models` response.
- The string after `anthropic/` must be a model the bridge resolves; check it against
  `GET /v1/models` on the bridge.

### Gateway not responding

```bash
LITELLM_PORT=4001 npm run litellm:start
export LITELLM_BASE_URL="http://127.0.0.1:4001"
```

The local gateway binds `127.0.0.1` by default.

## Official Documentation

- [LiteLLM Anthropic provider](https://docs.litellm.ai/docs/providers/anthropic)
- [LiteLLM Anthropic Messages endpoint](https://docs.litellm.ai/docs/anthropic_unified)
- [LiteLLM Claude Code quickstart](https://docs.litellm.ai/docs/tutorials/claude_responses_api)
- [LiteLLM Claude Code compatibility matrix](https://docs.litellm.ai/docs/claude_code_compatibility)
