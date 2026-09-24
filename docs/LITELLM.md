# LiteLLM Setup Guide

> **Language / 언어:** English | [한국어](LITELLM_KO.md)

This page puts a LiteLLM proxy in front of this repository's bridge, so LiteLLM clients,
including Claude Code through `./bin/claude-litellm`, use GitHub Copilot models.

One bridge is one GitHub Copilot seat. Every request through the gateway, whichever
virtual key sends it, is billed to the operator's seat and follows the operator's
organization policy.

LiteLLM adds virtual keys and request logging. The path loses three things the Direct path
has: Claude Code's 1M context window, the bridge's model list in `/model`, and the bridge's
own token counting. LiteLLM's cost tracking and budgets are wrong for Copilot models. See
[What Differs from the Direct Path](#what-differs-from-the-direct-path).

This path is not tested end to end; see [What Is Not Tested](#what-is-not-tested). If you
only need Claude Code on Copilot models, use the
[Direct path](../README.md#quick-start-direct-sdk) instead.

```text
Claude Code or another client -> LiteLLM -> bridge (src/server.mjs) -> @github/copilot-sdk -> GitHub Copilot
```

LiteLLM reaches the bridge through its `anthropic/*` provider, with `api_base` set to the
bridge root. LiteLLM's own `github_copilot/*` provider is a separate integration that does
not use this repository.

## Connect to an Existing Gateway

Use this section when someone else runs the gateway and gave you its URL and a key. You
need Claude Code, Node.js, Git and `curl`. You do not need `npm install` or
`copilot login`, because the operator's machine runs the bridge.

```bash
git clone https://github.com/junwoojeong100/claude-code-ghcp-sdk.git
cd claude-code-ghcp-sdk

export LITELLM_BASE_URL="https://litellm.example.com"   # no /v1
export LITELLM_API_KEY="<your virtual key>"

curl --silent --show-error --fail \
  -H "Authorization: Bearer $LITELLM_API_KEY" \
  "$LITELLM_BASE_URL/v1/models"
```

The `id` values in that list are the aliases the gateway serves. They are the valid values
for `LITELLM_MODEL`. `LITELLM_MODEL` defaults to `claude-sonnet-5`, which fails if the
gateway has no alias by that name.

```bash
export LITELLM_MODEL="claude-sonnet-5"
./bin/claude-litellm
```

Two rules apply:

- `LITELLM_BASE_URL` has no `/v1`. Claude Code appends `/v1/messages`, and `claude-litellm`
  refuses a URL that ends in `/v1`.
- The alias has no `[1m]` or `[NNNk]` suffix. LiteLLM rejects a bracketed name with
  `400 Invalid model name`.

Claude Code maps its Opus, Sonnet and Haiku choices to three family aliases, and it sends
its small background calls to the Haiku alias. If the gateway serves more than one model,
set them:

```bash
export LITELLM_OPUS_MODEL="claude-opus-5.5"
export LITELLM_SONNET_MODEL="claude-sonnet-5"
export LITELLM_HAIKU_MODEL="claude-haiku-4.5"
```

An unset family alias uses the main alias (`LITELLM_MODEL`). The flags
`--litellm-base-url` and `--litellm-model` override the variables. `claude-litellm`
refuses `--model`, `--settings` and `--ghcp-model`. It writes Claude Code's provider
settings to a mode-`0600` temporary file and deletes the file when Claude Code exits.

## Run a Gateway

Use this section to run the bridge and LiteLLM yourself. LiteLLM must run on the same
machine as the bridge, because the bridge that `ensure` starts always listens on
`127.0.0.1`. `ALLOW_NON_LOOPBACK` does not change that.

You need the [README requirements](../README.md#requirements), steps 1 and 2 of the
[Direct quick start](../README.md#quick-start-direct-sdk) (`npm install` and
`copilot login`), and `uv`, which setup uses to create a Python 3.13 environment. Run every
command from the repository root.

### 1. Pin the bridge port in your shell profile

Every `claude` or `claude-ghcp` launch on this machine, except a print-mode run (`-p`
without `--background` or `agents`), uses one shared background bridge
([The background bridge](../README.md#the-background-bridge)). A launch that asks for
another port, or for none, replaces the gateway's bridge. A plain `claude` counts when this
checkout's `bin/` is on your PATH. Add this line to your shell profile (for example
`~/.zshrc`) and open a new shell:

```bash
export GHCP_BRIDGE_PORT=4142
```

With `GHCP_BRIDGE_PORT` exported, a print-mode run starts its private bridge on the same
port. While the gateway's bridge holds that port, the run fails with
`GitHub Copilot model is unavailable: <model>`. Clear the variable for print mode:

```bash
GHCP_BRIDGE_PORT= ./bin/claude-ghcp -p "..."
```

Passing another `--bridge-port` also works.

### 2. Start the bridge and capture its token

Run this in an ordinary shell, one with the same environment your other terminals get. If
its bridge variables differ from theirs, your next `claude` launch replaces this bridge
([When the Bridge Is Replaced](#when-the-bridge-is-replaced)).

```bash
export GHCP_BRIDGE_URL="http://127.0.0.1:$GHCP_BRIDGE_PORT"   # the bridge root, no /v1
GHCP_BRIDGE_TOKEN="$(node src/bridge-daemon.mjs ensure claude-sonnet-5 "$GHCP_BRIDGE_PORT" \
  | node -pe 'JSON.parse(require("fs").readFileSync(0, "utf8")).token')" \
  && export GHCP_BRIDGE_TOKEN || unset GHCP_BRIDGE_TOKEN
```

`ensure` starts the bridge, or reuses the running one if its configuration matches, and
prints one JSON line. Its `token` field is the bridge credential. If `ensure` fails, it
prints the reason and `GHCP_BRIDGE_TOKEN` is left unset.

The model argument must be a model your Copilot account can use, and `ensure` checks it.
It does not limit which aliases LiteLLM can serve.

Check the bridge:

```bash
curl --silent --show-error --fail "$GHCP_BRIDGE_URL/health"

curl --silent --show-error --fail \
  -H "x-api-key: $GHCP_BRIDGE_TOKEN" \
  "$GHCP_BRIDGE_URL/v1/models?all=true"
```

The second call lists every model ID in your Copilot catalogue. Those IDs are what goes
after `anthropic/` in the LiteLLM config. `./bin/ghcp-models` prints the same IDs, except
`claude-fable-*`, without going through the bridge. Plain `/v1/models` without `?all=true`
lists at most the three GPT-6 rows that Claude Code's `/model` discovery uses, so do not
check models against it.

Every bridge route except `GET /health` and `HEAD /api/hello` needs the token, sent as
`x-api-key` or `Authorization: Bearer`. Anyone with the token can use your Copilot seat, so
treat it like a password ([Security Boundaries](ARCHITECTURE.md#security-boundaries)).

### 3. Install and start LiteLLM

In the same shell as step 2:

```bash
npm run litellm:setup   # once: LiteLLM v1.97.0 into .runtime/, plus a master key
npm run litellm:start
```

`litellm:start` reads `GHCP_BRIDGE_URL` and `GHCP_BRIDGE_TOKEN` from this shell. It refuses
to start without them, or when `GHCP_BRIDGE_URL` ends in `/v1`. By default it loads
[`examples/litellm-github-copilot.yaml`](../examples/litellm-github-copilot.yaml), which
needs no edits. That file defines six aliases, all pointing at the bridge:
`claude-opus-5.5`, `claude-sonnet-5`, `claude-haiku-4.5`, `gpt-6-astra`, `gpt-6-sol` and
`gpt-6-luna`.

LiteLLM listens on `127.0.0.1:4000`. `LITELLM_HOST` and `LITELLM_PORT` change the address,
and `LITELLM_CONFIG` changes the config file. Keep this terminal open. It prints
`Application startup complete` when LiteLLM is ready.

LiteLLM reads the token once, at startup. Whenever the bridge is replaced, restart LiteLLM
(Ctrl-C, then `npm run litellm:start`) with the new token; see
[When the Bridge Is Replaced](#when-the-bridge-is-replaced).

### 4. Connect Claude Code

In a second terminal:

```bash
export LITELLM_BASE_URL="http://127.0.0.1:4000"
export LITELLM_API_KEY="$(tr -d '\n' < .runtime/litellm-master-key)"
export LITELLM_MODEL="claude-sonnet-5"

./bin/claude-litellm
```

Everything in [Connect to an Existing Gateway](#connect-to-an-existing-gateway) applies,
with the local URL and the master key.

The master key controls the whole gateway, so give other people
[virtual keys](https://docs.litellm.ai/docs/proxy/virtual_keys) instead. Other people can
reach the gateway only if you set `LITELLM_HOST` to a network address. Every request they
send then uses your Copilot seat.

### 5. Optional: change the config

To add, rename or remove aliases, copy the example file, edit the copy, and start LiteLLM
with `LITELLM_CONFIG=<copy> npm run litellm:start`. One of the six entries, and the general
settings:

```yaml
model_list:
  - model_name: claude-sonnet-5
    litellm_params:
      model: anthropic/claude-sonnet-5
      api_base: os.environ/GHCP_BRIDGE_URL
      api_key: os.environ/GHCP_BRIDGE_TOKEN

general_settings:
  master_key: os.environ/LITELLM_MASTER_KEY
  forward_client_headers_to_llm_api: true
```

| Field | Set it to | Why |
|---|---|---|
| `model_name` | Any name without `[1m]` or `[NNNk]` | It is the alias clients ask for (`LITELLM_MODEL`). LiteLLM rejects a bracketed name. |
| `model: anthropic/<id>` | A Copilot model ID from `./bin/ghcp-models` | LiteLLM sends everything after `anthropic/` as the request's `model`. The bridge strips a `[1m]` suffix here and picks the Copilot context tier by model ([details](ARCHITECTURE.md#model-discovery-and-context)). |
| `api_base` | The bridge root, with no path | LiteLLM appends `/v1/messages`. `litellm:start` refuses a `GHCP_BRIDGE_URL` ending in `/v1`, but it does not check a literal `api_base` in your own file. Such a value gets `404 not_found_error`. |
| `api_key` | `os.environ/GHCP_BRIDGE_TOKEN` | LiteLLM sends it as `x-api-key`, which the bridge accepts. |
| `forward_client_headers_to_llm_api` | `true` | It passes Claude Code's `x-claude-code-session-id` and `x-claude-code-agent-id` headers to the bridge. The bridge uses them to keep each conversation and each subagent in its own Copilot session. |
| `forward_llm_provider_auth_headers` | Leave it unset | It forwards the client's own `x-api-key`, which overrides `api_key`. |

### 6. Stop

Press Ctrl-C in the LiteLLM terminal. `./bin/claude-ghcp-stop` stops the bridge, along with
any replaced bridge that is still running, and deletes `bridge.log`. Every `claude` or
`claude-ghcp` session on this machine that uses those bridges (all but print-mode runs)
loses its connection. Neither the bridge nor LiteLLM starts again by itself after a reboot,
so repeat steps 2 and 3.

## When the Bridge Is Replaced

The gateway breaks when the bridge on port 4142 goes away or gets a new token. LiteLLM
keeps the token it read at startup, so every fix ends with a LiteLLM restart.

| Cause | What LiteLLM gets | Fix |
|---|---|---|
| A `claude` or `claude-ghcp` launch (not `-p`) without `GHCP_BRIDGE_PORT=4142`, or with another `--bridge-port`. A plain `claude` counts when this checkout's `bin/` is on your PATH. | Nothing at first. The launch starts a new bridge on another port, and the old bridge keeps answering LiteLLM. The old bridge exits once no launcher that started on it is still running and it has had no request for `RETIRED_IDLE_MS` (1 hour by default). LiteLLM's own requests count, so this happens after LiteLLM has been idle that long. From then on, LiteLLM's connections to port 4142 are refused. | Re-run step 2 in the gateway shell, then restart LiteLLM. Do step 1 so it does not happen again. |
| A launch or `ensure` on port 4142 after the bridge's configuration changed: an edit or a pull that changes `src/*.mjs`, `package.json` or `package-lock.json`, a launch from a moved, renamed or second clone, or a bridge variable such as `LOG_LEVEL`, `COPILOT_*` or `HOME` that is set, unset or changed. | `401 authentication_error` with `Invalid bridge credential.`, at once. The old bridge is stopped, and the new bridge on port 4142 has a new token. | Read the new token from `bridge.json` (below), export it as `GHCP_BRIDGE_TOKEN`, then restart LiteLLM. |
| `./bin/claude-ghcp-stop`, or a reboot | Its connections to port 4142 are refused. | Re-run step 2, then restart LiteLLM. |

`./bin/claude-ghcp-status` tells the rows apart. A `port` other than 4142 means the first
row. `"running": false` means the third. It never prints the token.

The token is in `bridge.json`, in the bridge's daemon directory:

| When | Path |
|---|---|
| `GHCP_DAEMON_DIR` is set | `$GHCP_DAEMON_DIR/bridge.json` |
| macOS | `~/Library/Caches/claude-code-ghcp-sdk/bridge.json` |
| Linux | `${XDG_CACHE_HOME:-~/.cache}/claude-code-ghcp-sdk/bridge.json` |

```bash
# macOS path shown; use the path from the table for your system.
export GHCP_BRIDGE_TOKEN="$(node -pe \
  'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).token' \
  ~/Library/Caches/claude-code-ghcp-sdk/bridge.json)"
```

For the second row, read the file rather than re-running step 2. `ensure` returns the
running bridge's token only when the calling shell's bridge variables match that bridge.
From a shell whose bridge variables differ, it replaces the bridge again, with another new
token, and the sessions using the old one lose their connection. The full list of what
counts as a configuration change is in
[Persistent Bridge and Retirement](ARCHITECTURE.md#persistent-bridge-and-retirement).

## What Differs from the Direct Path

- **Context window.** Claude Code gives every alias its default 200K window, because an
  alias cannot carry the `[1m]` hint that gives Claude Code a 1M window. `claude-litellm`
  sets no context override. For a 1M window in Claude Code, use the Direct path
  ([Models](../README.md#models)).
- **`/model`.** The picker shows the Opus, Sonnet and Haiku rows, labelled
  `LiteLLM · <alias>`, plus `LITELLM_MODEL` when it is none of those. It does not show the
  bridge's GitHub Copilot model list.
- **Token counting.** LiteLLM answers Claude Code's `/v1/messages/count_tokens` requests
  with its own estimate. They never reach the bridge.
- **Cost and budgets.** LiteLLM prices requests from its own price list, not from what
  GitHub Copilot charges. Its cost dashboard and spend budgets are therefore wrong for these
  models. Check usage against your GitHub Copilot AI Credits instead.
- **Sampling controls.** `temperature`, `top_p`, `max_tokens` and `stop_sequences` have no
  effect on either path; see [Unsupported Controls](COMPATIBILITY.md#unsupported-controls).
- **Errors.** The bridge returns the same statuses as on the Direct path; see
  [Upstream Errors](ARCHITECTURE.md#upstream-errors) and
  [Rate limits and timeouts](../README.md#rate-limits-and-timeouts). On a streamed request,
  a failure before the first streamed text, reasoning or tool-call delta gets that HTTP
  status. A failure after it arrives as an `event: error` frame with the same error type, on
  a response whose status is already `200`. Each failed `/v1/messages` request writes a
  `bridge.request_failed` line to `bridge.log` in the daemon directory
  ([Logging](ARCHITECTURE.md#logging)).

## What Is Not Tested

`npm run verify` never starts LiteLLM: it runs Claude Code against the bridge directly.
`npm test` covers only the `claude-litellm` launcher and the settings file it writes, with a
stand-in for Claude Code. Nothing tests `npm run litellm:setup`, `npm run litellm:start` or
the example config. Everything this page says about LiteLLM's own behaviour (the URL it
builds, the headers it forwards, the names it rejects, how it answers `count_tokens`, how it
prices requests) is written for v1.97.0, the version `npm run litellm:setup` installs, and
is not tested. Whether LiteLLM passes a bridge `429` or `529` to its client unchanged, or
retries it first, is not tested either. For what the matrix does cover, see
[What works and what does not](../README.md#what-works-and-what-does-not).

## Troubleshooting

### `GHCP_BRIDGE_URL is required: the bridge root, with no /v1 suffix.`

`npm run litellm:start` ran in a shell without the variables from
[step 2](#2-start-the-bridge-and-capture-its-token). Run it in the shell where you ran
step 2.

### `GHCP_BRIDGE_TOKEN is required: the token printed by bridge-daemon ensure.`

Either `npm run litellm:start` ran in another shell, or step 2's `ensure` failed and left
the token unset. Run it in the step 2 shell. If the token is missing there too, re-run
[step 2](#2-start-the-bridge-and-capture-its-token) and read the reason `ensure` prints.

### `GHCP_BRIDGE_URL must not end in /v1; LiteLLM appends /v1/messages.`

Set `GHCP_BRIDGE_URL` to the bridge root, `http://127.0.0.1:4142`.

### `Invalid LiteLLM base URL: URL must not end in /v1; Claude Code appends /v1/messages`

Remove `/v1` from `LITELLM_BASE_URL` or `--litellm-base-url`.

### LiteLLM cannot connect to the bridge

No bridge is listening on the port LiteLLM uses, so the connection is refused. Run
`./bin/claude-ghcp-status`. A `port` other than 4142 means a launch without
`GHCP_BRIDGE_PORT` replaced the gateway's bridge. `"running": false` means the bridge was
stopped or the machine rebooted. Both fixes are in
[When the Bridge Is Replaced](#when-the-bridge-is-replaced).

### `401` `authentication_error`: `Invalid bridge credential.`

LiteLLM is using an old token. Either the bridge on 4142 was replaced, or LiteLLM was
started with a token exported in another shell. Export the current token from
`bridge.json` and restart LiteLLM; see
[When the Bridge Is Replaced](#when-the-bridge-is-replaced).

### `400 Invalid model name` from LiteLLM

The alias the client asked for is not a `model_name` in LiteLLM's config, because of a typo
or a `[1m]` or `[NNNk]` suffix. The bridge never sees the request. Use an `id` from
LiteLLM's `/v1/models`. With `claude-litellm`, check `LITELLM_MODEL`, `--litellm-model` and
the three family aliases.

### `GitHub Copilot model "<id>" is unavailable. Available adapter models: …`

This comes from the bridge, as `400 invalid_request_error`. The string after `anthropic/`
in the config is not a model the bridge can resolve. The message lists the IDs it can use,
and `./bin/ghcp-models` prints the same list.

### `GitHub Copilot model is unavailable: <model>`

From step 2, the model you passed to `ensure` is not available to your Copilot account.
Pick one from `./bin/ghcp-models`.

From a `claude -p` or `claude-ghcp -p` run on the gateway machine, with an `HTTP 401` line
just before it, the private bridge tried to use the gateway's port. Run print mode with
`GHCP_BRIDGE_PORT=` cleared; see [step 1](#1-pin-the-bridge-port-in-your-shell-profile).

### `404` `not_found_error`: `Not found.`

The `api_base` in your own config has a path, usually `/v1`. Use scheme, host and port only.

### Requests from different conversations wait for each other

Your config lacks `forward_client_headers_to_llm_api: true`; the example file sets it.
Without it the bridge cannot tell conversations or subagents apart, so it runs all their
requests one at a time, as one conversation.

### LiteLLM does not start because port 4000 is in use

Start LiteLLM on another port and point the client at it:

```bash
LITELLM_PORT=4001 npm run litellm:start
export LITELLM_BASE_URL="http://127.0.0.1:4001"
```

## Official Documentation

- [LiteLLM Anthropic provider](https://docs.litellm.ai/docs/providers/anthropic)
- [LiteLLM Anthropic Messages endpoint](https://docs.litellm.ai/docs/anthropic_unified)
- [LiteLLM virtual keys](https://docs.litellm.ai/docs/proxy/virtual_keys)
- [LiteLLM Claude Code quickstart](https://docs.litellm.ai/docs/tutorials/claude_responses_api)
- [LiteLLM Claude Code compatibility matrix](https://docs.litellm.ai/docs/claude_code_compatibility)
