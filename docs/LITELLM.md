# LiteLLM Setup Guide

> **Language / 언어:** English | [한국어](LITELLM_KO.md)

This guide puts **this repository's bridge behind a LiteLLM proxy**, so LiteLLM clients
reach GitHub Copilot models through `src/server.mjs`. If you only need Claude Code talking
to the bridge, follow the [README](../README.md#direct-sdk-quick-start) instead; LiteLLM
adds a hop, not a capability.

## Topology

```text
Direct:  Claude Code -> bridge (src/server.mjs) -> @github/copilot-sdk -> Copilot model
LiteLLM: any client  -> LiteLLM -> bridge (src/server.mjs) -> @github/copilot-sdk -> Copilot model
```

LiteLLM uses its `anthropic/*` provider with `api_base` set to the bridge root. This page
does **not** use LiteLLM's own `github_copilot/*` provider, which runs its own GitHub
device-OAuth flow, keeps its own credentials under `~/.config/litellm/github_copilot`, and
never touches this repository or `@github/copilot-sdk`.

LiteLLM adds virtual keys, budgets, request logging and an OpenAI-shaped surface in front
of a bridge that speaks only the Anthropic Messages API, to one loopback caller, with one
credential.

## Verification Scope

LiteLLM is outside this repository's verification scope. The `npm run verify` matrix
(6 models x 11 scenarios = 66 slots) starts `src/server.mjs` directly and never starts
LiteLLM, so treat this page as a configuration reference, not a validated path.

Statements about LiteLLM's own behaviour are written against `v1.97.0`, the release
`npm run litellm:setup` pins (commit `ef84494`, `scripts/setup-litellm.sh`). That is a pin,
not a test result: another release may append a different path, forward different
headers, or reject different model strings. Statements about `src/` are read from this
repository's source and name the file. See
[Validation Scope](ARCHITECTURE.md#validation-scope) for what is covered.

## What the Bridge Exposes

The `api_base` you give LiteLLM must match this surface, all of it in `src/server.mjs`:

| Method and path | Auth | Notes |
|---|---|---|
| `POST /v1/messages` | required | The only inference route |
| `POST /v1/messages/count_tokens` | required | LiteLLM never calls it — see Known Constraints |
| `GET /health` | none | Safe for liveness probes |
| `HEAD /api/hello` | none | Answered before the auth gate; `200` with an empty body |
| `GET /v1/models` | required | Model catalogue |
| anything else | required | `404` with `not_found_error` — but the auth gate runs first, so a bad credential gets `401` instead |

Authentication accepts either `Authorization: Bearer <token>` or `x-api-key: <token>`.
The bridge binds to loopback only, unless `ALLOW_NON_LOOPBACK=1` is set.

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

LiteLLM needs a bridge URL and token that outlive any one Claude Code run, so use the
persistent bridge and **pin its port**; without a port it picks a free one. This is the
bridge that every `claude-ghcp` launch except `-p` shares; see
[Persistent bridge and print mode](../README.md#persistent-bridge-and-print-mode).

```bash
export GHCP_BRIDGE_PORT=4142
export GHCP_BRIDGE_URL="http://127.0.0.1:$GHCP_BRIDGE_PORT"   # bridge root, no /v1

# On failure, ensure prints its message on stderr and leaves stdout empty.
GHCP_REGISTRY="$(node src/bridge-daemon.mjs ensure claude-sonnet-5 "$GHCP_BRIDGE_PORT")"
if [ -n "$GHCP_REGISTRY" ]; then
  export GHCP_BRIDGE_TOKEN="$(printf '%s' "$GHCP_REGISTRY" \
    | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>process.stdout.write(JSON.parse(d).token))')"
else
  # Fail closed: a token left over from an earlier run names a bridge that is gone.
  unset GHCP_BRIDGE_TOKEN
  echo "ensure failed; its message is above. GHCP_BRIDGE_TOKEN is now unset." >&2
  false
fi
```

`ensure` starts the bridge, or reuses it when it is already running with the same
configuration, and prints its registry as one JSON line:

```json
{"createdAt":"...","configFingerprint":"...","instanceId":"...","model":"claude-sonnet-5","pid":12345,"port":4142,"token":"<48-hex-characters>","version":1,"leasePath":"...","logPath":"...","settingsPath":"..."}
```

LiteLLM needs only `port` and `token`. `logPath` is the bridge log. `leasePath` and
`settingsPath` are per-launch paths for `claude-ghcp`; ignore them.

The `else` branch unsets `GHCP_BRIDGE_TOKEN` because every later check, including
[`../scripts/start-litellm.sh`](../scripts/start-litellm.sh), only tests that the variable
is non-empty: a stale token would start a gateway that fails on its first request. It ends
in `false` rather than `exit`, so it stops a `set -e` script without closing an
interactive shell. If `ensure` prints something that is not registry JSON, the parser
fails and the token is exported empty, which the same checks reject.

Confirm the bridge is up before configuring anything else:

```bash
curl --silent --show-error --fail "$GHCP_BRIDGE_URL/health"

curl --silent --show-error --fail \
  -H "x-api-key: $GHCP_BRIDGE_TOKEN" \
  "$GHCP_BRIDGE_URL/v1/models"
```

The bridge runs in its daemon directory (below), so it does not matter which directory you
run `ensure` from.

### Recovering the token later

`./bin/claude-ghcp-status` prints `{model, pid, port, retired, running}` and never the
token. Read the token from the registry file:

| Location | Path |
|---|---|
| `GHCP_DAEMON_DIR` is set | `$GHCP_DAEMON_DIR/bridge.json` |
| macOS default | `~/Library/Caches/claude-code-ghcp-sdk/bridge.json` |
| Linux default | `${XDG_CACHE_HOME:-~/.cache}/claude-code-ghcp-sdk/bridge.json` |

The directory is `0700` and the file is `0600`. Treat the token like a password: it lets a
caller use your GitHub Copilot seat.

Re-running `ensure` also returns the token, but it can fail where reading the file cannot.
Before it returns a running bridge, it checks the model you name against the bridge's
`/v1/models?all=true` and throws `GitHub Copilot model is unavailable: <model>` if the
model is absent (`src/bridge-daemon.mjs`).

`./bin/claude-ghcp-stop` stops the bridge and any retired bridges, including the one that
running `claude-ghcp` sessions share.

### The `GHCP_BRIDGE_PORT` trap

Every `claude-ghcp` launch except `-p` calls `ensure` with `GHCP_BRIDGE_PORT` (or
`--bridge-port`) as the requested port, and with no port when neither is set. The
requested port is part of the configuration fingerprint (`daemonConfigFingerprint` in
`src/bridge-daemon.mjs`). So a launch from a shell without `GHCP_BRIDGE_PORT=4142`
replaces your pinned bridge:

1. The launcher starts a new bridge on a free port with a new token.
2. Your pinned bridge is retired. It keeps its port and token and keeps answering LiteLLM.
3. It exits once it has had no request for `RETIRED_IDLE_MS` (default 1 hour) and no
   launcher that used it is still running. LiteLLM then gets connection refused.

Export `GHCP_BRIDGE_PORT=4142` in both shells, before `ensure` and before the launcher.
The rest of the fingerprint must match too: the same clone and the same bridge environment
variables (see [Known Constraints](#known-constraints)).

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

Keep brackets out of `model_name` and `--litellm-model`. LiteLLM does not strip a `[1m]`
or `[NNNk]` suffix, so it cannot match a bracketed alias and rejects the request with
`400 Invalid model name` (LiteLLM behaviour this repository does not verify).

The suffix does nothing on the bridge side either. The bridge strips it before resolving
the model (`stripContextSuffix` in `src/model-map.mjs`) and picks the SDK tier by model:
GPT-6 Astra, Sol and Luna, GPT-5.6, Claude Opus 5.5, 5, 4.8 and 4.7, and Claude Sonnet 5
get the long-context tier when the Copilot catalogue advertises at least 1M tokens
(`sdkContextOptionsFor`). So `anthropic/<id>[1m]` behaves exactly like `anthropic/<id>`.

Claude Code sizes its own context window from the configured model name. On this path that
is the bracket-free alias, so Claude Code keeps its default window even when the bridge
serves a 1M tier; `src/write-litellm-settings.mjs` sets no context override. For a 1M
window in Claude Code, use the Direct path, whose launch and picker IDs carry a
model-scoped `[1m]` hint; see [Run Claude Code](../README.md#4-run-claude-code).

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
string. `LITELLM_BASE_URL` must not end in `/v1` either: Claude Code appends `/v1/messages`
the same way LiteLLM does, and `src/write-litellm-settings.mjs` rejects it.
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
- **A configuration change rotates the token.** `daemonConfigFingerprint` hashes the
  bridge environment variables (`COPILOT_*`, `MAX_*`, `RETIRED_IDLE_MS`, the other timeout
  variables, `GH_TOKEN`, `GITHUB_TOKEN`, the proxy variables, `HOME` and the rest matched
  there), the clone's absolute path, `package.json`, `package-lock.json`, every `src/*.mjs`
  file, and the requested port. When any of them changes, the next `ensure` or
  `claude-ghcp` launch on the pinned port stops the bridge and starts a new one on the same
  port with a new token. Editing a file under `src/`, pulling new commits, and moving or
  renaming the clone are each enough. Re-export `GHCP_BRIDGE_TOKEN` and restart LiteLLM
  after every replacement.
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
- **Sampling controls are ignored.** The Copilot SDK does not expose `temperature`,
  `top_p`, `max_tokens` or `stop_sequences`. LiteLLM forwards them, and the bridge accepts
  and ignores them whichever front end sends them. `GET /health` lists them under
  `unsupportedNativeControls`, and a request that sends one writes a
  `bridge.degraded_controls` line. Other accepted fields the bridge does not act on
  (`thinking`, `top_k`, `metadata` and the rest) are listed under `ignoredRequestFields`
  and appear as `ignoredFields` on the same line.
- **Do not set `forward_llm_provider_auth_headers`.** That setting — a different one from
  `forward_client_headers_to_llm_api` — forwards a client's own `x-api-key` and overrides
  the configured bridge key.
- **The local setup pins FastAPI `0.139.0`.** `scripts/setup-litellm.sh` installs
  `litellm[proxy]`, then overwrites its FastAPI with `0.139.0`. The script gives no reason
  for the pin, and this page describes only that pair.

## Troubleshooting

### `404` `not_found_error` from the bridge

`api_base` has a path. Use scheme, host and port only; LiteLLM appends `/v1/messages`.
The bridge answers `404` for any path outside the routes above, but only after
authentication: with a missing or wrong credential the same request gets `401`
`authentication_error`.

### `Connection refused` from LiteLLM

No bridge is listening on LiteLLM's port. Usually a `claude-ghcp` launch without
`GHCP_BRIDGE_PORT` retired your pinned bridge and it has since exited (see
[The `GHCP_BRIDGE_PORT` trap](#the-ghcp_bridge_port-trap)), or `claude-ghcp-stop` stopped
it. Check with `./bin/claude-ghcp-status`, export the port in both shells, re-run
[the `ensure` block](#1-start-the-persistent-bridge), and restart LiteLLM with the new
token.

### `401` from the bridge

- The bridge on that port was replaced and has a new token (see
  [Known Constraints](#known-constraints)). Re-run `ensure`, re-export `GHCP_BRIDGE_TOKEN`,
  and restart LiteLLM.
- `GHCP_BRIDGE_TOKEN` was not exported before LiteLLM started; `os.environ/` resolves at
  load time.

### `400 Invalid model name`

The requested model has a `[1m]` or `[NNNk]` suffix. LiteLLM rejects it, not the bridge.
Use a bracket-free `model_name` and `--litellm-model`; see
[The `[1m]` context suffix](#the-1m-context-suffix).

### `429`, `529` or another error from the bridge

`errorResponse` in `src/server.mjs` maps failures as the
[README](../README.md#rate-limits-and-upstream-errors) describes:

| Failure | Status and type |
|---|---|
| Copilot `rate_limit` or `quota` error, or upstream HTTP 429 | `429` `rate_limit_error` |
| Upstream HTTP 5xx | `529` `overloaded_error` |
| `BridgeRequestError` (including a context-limit error), `ModelUnavailableError`, `ReasoningEffortUnavailableError` | `400` `invalid_request_error` |
| Anything else | `500` `api_error` |

LiteLLM streams. The bridge starts a streaming response at the model's first text,
reasoning or tool-call delta. A failure before that gets the status above. A failure after
it arrives as an `event: error` frame with the same type, on a response whose status is
already `200` (`writeSseError` in `src/anthropic.mjs`). The bridge sends no `retry-after`
header, because the SDK reports no retry time. How LiteLLM relays these to its own client
is LiteLLM behaviour this repository does not verify.

The `message` is the underlying error's own, forwarded verbatim; read it rather than
matching on a fixed string. Each failure also writes a content-free
`bridge.request_failed` line, with status and type, to `bridge.log` in the daemon
directory.

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
