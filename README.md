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

## Security

- Prefer `$ENV_VAR` API keys over pasting raw secrets into `models.json`
- Never commit your personal `models.json`
- Self-check sends minimal chat probes (`"hi"`, `max_tokens: 1`) to **your** base URL only

## Changelog

### v1.0.0

- Interactive `/provider` management (add / copy / edit / remove / test / status / archive)
- Adaptive capability self-check on add, edit save, and `/provider check`
- OpenAI-family probes for max-tokens field, store, stream usage, developer role, reasoning

## Acknowledgements

This open-source project is linked and recognized by the [LINUX DO](https://linux.do) community.

## License

MIT — see [LICENSE](./LICENSE).
