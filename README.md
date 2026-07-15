# pi-provider

**English** | [简体中文](./README.zh-CN.md)

[![pi package](https://img.shields.io/badge/pi-package-blue)](https://github.com/earendil-works/pi-coding-agent)
[![license](https://img.shields.io/badge/license-MIT-green)](./LICENSE)
[![release](https://img.shields.io/github/v/release/BevalZ/pi-provider?display_name=tag&sort=semver)](https://github.com/BevalZ/pi-provider/releases)

Provider manager for [Pi](https://github.com/earendil-works/pi-coding-agent) — manage custom entries in `~/.pi/agent/models.json` with **capability self-check** and **adaptive `compat` rewriting**.

When you add or edit a provider, pi-provider probes the endpoint and turns off unsupported features (reasoning, `store`, developer role, wrong max-tokens field, …) so the written config matches what the gateway actually accepts.

## Install

Requires [Pi coding agent](https://github.com/earendil-works/pi-coding-agent).

```bash
pi install git:github.com/BevalZ/pi-provider
```

Then restart Pi or run `/reload`.

## Usage

```text
/provider                 Interactive management menu
/provider add             Add a provider (self-check before save)
/provider edit [name]     Edit a provider (self-check on save)
/provider check [name]    Re-probe capabilities and rewrite compat/reasoning
/provider copy [name]     Copy a provider to a new name
/provider remove          Remove a provider
/provider test            Connectivity & latency test
/provider status          View details + refresh
/provider archive         Move active → archived
/provider archived        List / reactivate archived providers
/provider activate [name] Reactivate an archived provider
```

### First-time flow

```bash
# 1. Install
pi install git:github.com/BevalZ/pi-provider

# 2. Add a provider
/provider add
#    name → base URL → API key → API type → model id → input types
#    prefer reasoning? (will auto-disable if unsupported)
#    self-check runs, then writes models.json

# 3. Use the model
/model
```

Prefer storing secrets as env vars: set API key to `$MY_PROVIDER_KEY` and export that variable in your shell.

## Full menu reference

Everything below matches the interactive TUI after `/provider` (or a subcommand).

### Main menu — `Provider management`

| Menu item | What it does |
|-----------|----------------|
| **Add** | Create a provider; self-check before save |
| **Copy** | Deep-copy an existing provider under a new name |
| **Edit** | Edit fields; self-check on save |
| **Remove** | Hard-delete from active `providers` (not undoable) |
| **Test** | Connectivity / latency / remote model list |
| **Check** | Re-probe capabilities and rewrite `compat` / `reasoning` |
| **Status** | Full detail view + re-test |
| **Archive** | Move active → `archivedProviders` |
| **Archived** | Browse archive: details / restore / permanent delete |

---

### Add flow

| Step | UI | Notes |
|------|-----|--------|
| 1 | Input **Provider name** | Config key in `models.json` |
| 2 | If name exists | Confirm overwrite |
| 3 | If name is archived | Offer to **activate** instead |
| 4 | Input **Base URL** | e.g. `https://api.example.com/v1` |
| 5 | Input **API key** | Supports `$ENV_VAR` |
| 6 | Select **API type** | See table below |
| 7 | Input **Model ID** | e.g. `gpt-4` |
| 8 | Input **Display name** | Empty → use Model ID |
| 9 | Select **Input types** | Text / Text + Image |
| 10 | Confirm **Reasoning** | Prefer extended thinking if supported |
| 11 | **Self-checking…** | Probes endpoint; rewrites `compat` |
| 12 | On self-check failure | Confirm whether to save best-effort flags |

**API type**

| Option | Meaning |
|--------|---------|
| Openai-completions (OpenAI 兼容) | Chat Completions (most gateways) |
| Anthropic-messages (Claude 兼容) | Anthropic Messages API |
| Openai-responses | OpenAI Responses API |
| Google-generative-ai | Google Generative AI |
| Mistral-conversations | Mistral |

**Input types**

| Option | Meaning |
|--------|---------|
| Text | Text only |
| Text + Image | Multimodal |

---

### Copy flow

| Step | Notes |
|------|--------|
| Select source provider | Fuzzy search |
| Input new name | Target config key |
| If target exists | Confirm overwrite |
| If target is archived | Must activate/remove archive first |
| Deep copy | Includes models, compat, key, headers |

---

### Edit menu — `Edit provider: <name>`

| Field | Function |
|-------|----------|
| **Config name** | Rename the provider key |
| **Endpoint** | Change `baseUrl` |
| **API key** | Change secret (Enter keeps current) |
| **Name field** | Display `name`; enter `-` to clear |
| **API type** | Same API type menu as Add |
| **Models** | Open model picker → model editor |
| **s Save** | Persist after self-check |
| **x Discard** | Drop edits |

**Edit model** (after choosing a model)

| Field | Function |
|-------|----------|
| **ID** | Model id |
| **Name** | Display name |
| **Context window** | Context tokens |
| **Max output** | Max output tokens |
| **s Save / x Back** | Save model draft or return |

On provider save: self-check → optional save-on-failure → write `models.json` → refresh registry.

---

### Remove

| Step | Notes |
|------|--------|
| Select provider | |
| **Confirm deletion** | Permanent remove from active list |
| Tip | Prefer **Archive** if you may need it later |

---

### Test results

| Step | Notes |
|------|--------|
| Select provider | |
| Probe request | Streaming chat (OpenAI-family) or Anthropic messages |
| Results screen | Status, latency, TTFB, connect |
| Remote `/models` | Multi-column list; `[*]` = currently registered |

---

### Check (capability re-probe)

| Step | Notes |
|------|--------|
| Select provider | |
| **Reasoning preference** | Whether to keep trying extended thinking |
| **Self-checking…** | Same probes as Add |
| On failure | Optional write of best-effort flags |
| Persist | Updates `compat` + per-model `reasoning` / `thinkingLevelMap` |

---

### Status view — `Status: <name>`

Shows:

- Provider / Endpoint / API / API key preview / Status
- **Performance**: Latency, TTFB, Connect
- **Compatibility**: current `compat` key/values
- **Models**: reasoning, input, context, max output, thinking map
- **Remote models**: cloud list vs registered

**Next action**

| Option | Function |
|--------|----------|
| **Refresh** | Re-test this provider |
| **Back** | Pick another provider |
| **Exit** | Return to chat |

---

### Archive

| Step | Notes |
|------|--------|
| Select active provider | |
| Confirm | |
| Effect | Moves to `archivedProviders` with `archivedAt`; removed from active |

---

### Archived browser

| Action | Function |
|--------|----------|
| Select archived item | Fuzzy list |
| **Details** | Endpoint, API, models, archived time |
| **Restore** | Reactivate (same as Activate) |
| **Delete** | Permanently delete from archive |
| **← Back** | Leave action menu |

---

### Activate (restore archived)

| Step | Notes |
|------|--------|
| Select archived name (or pass on CLI) | |
| If active name collides | Confirm overwrite |
| Effect | Strip `archivedAt`, write to `providers`, drop from archive |

CLI aliases: `activate` · `unarchive` · `restore`

---

### Command cheat sheet

```text
/provider
/provider add
/provider copy [name]
/provider edit [name]
/provider remove
/provider test
/provider check [name]
/provider status
/provider archive [name]
/provider archived   # or: list
/provider activate [name]
```

## Self-check (OpenAI-family)

After **add** / **edit save** / **check**, for `openai-completions` and `openai-responses` the extension probes:

| Probe | Adaptive write |
|-------|----------------|
| `max_completion_tokens` vs `max_tokens` | `compat.maxTokensField` |
| `store` | `compat.supportsStore` |
| `stream_options.include_usage` | `compat.supportsUsageInStreaming` |
| `developer` role | `compat.supportsDeveloperRole` |
| `reasoning_effort` | `supportsReasoningEffort` + model `reasoning` + `thinkingLevelMap` |
| empty `reasoning_content` on assistant | `requiresReasoningContentOnAssistantMessages` |

Unsupported features are written as `false` and reasoning maps are stripped so Pi does not send rejected parameters.

Anthropic / Google / Mistral: connectivity check only (detailed compat probe is OpenAI-family for now).

If self-check fails (auth / network), you can still choose to save best-effort flags.

## What it manages

Writes to `~/.pi/agent/models.json`:

- Active `providers`
- `archivedProviders` (soft-delete / reactivate)

Does **not** upload your API keys anywhere except the endpoints you configure.

## Structure

```text
pi-provider/
  package.json
  LICENSE
  README.md
  README.zh-CN.md
  scripts/
    sync-shared.mjs   # keep vendored files in sync with local Pi install
    detect-test.mjs   # smoke tests for structured error detection
  extensions/
    provider/
      index.ts          # /provider command
    _shared/
      box-drawing.ts
      enhanced-select.ts
      entity-crud.ts
      edit-menu.ts
      json-io.ts
      fetch-utils.ts
```

## Development

The package vendors `provider/index.ts` plus a few `_shared/*` helpers that are
also edited in-place in a live Pi install (`~/.pi/agent/extensions`). Those
copies drift over time, so a sync script keeps them aligned:

```bash
npm run sync-shared     # copy canonical (local Pi install) → package
npm run check-shared    # exit 1 if any vendored file differs (CI / pre-release)
npm test                # smoke tests for the structured error detectors
```

Source resolution: `--source <dir>` → `$PI_EXTENSIONS_DIR` → `~/.pi/agent/extensions`.
Run `check-shared` before tagging a release so published files never lag behind local edits.

## Security

- Prefer `$ENV_VAR` API keys over pasting raw secrets into `models.json`
- Never commit your personal `models.json`
- Self-check sends minimal chat probes (`"hi"`, `max_tokens: 1`) to **your** base URL only

## Changelog

### v1.1.0

- Structured error detection: prefer OpenAI-style `error.param` / `error.code` / `error.type` over text matching, with regex as fallback — fewer false positives on rate-limit / model-not-found errors
- `sync-shared` script keeps vendored files aligned with the local Pi install
- `detect-test` smoke tests for the capability detectors

### v1.0.0

- Interactive `/provider` management (add / copy / edit / remove / test / status / archive)
- Adaptive capability self-check on add, edit save, and `/provider check`
- OpenAI-family probes for max-tokens field, store, stream usage, developer role, reasoning

## Acknowledgements

This open-source project is linked and recognized by the [LINUX DO](https://linux.do) community.

## License

MIT — see [LICENSE](./LICENSE).
