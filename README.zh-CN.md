# pi-provider

[English](./README.md) | **简体中文**

[![pi package](https://img.shields.io/badge/pi-package-blue)](https://github.com/earendil-works/pi-coding-agent)
[![license](https://img.shields.io/badge/license-MIT-green)](./LICENSE)
[![release](https://img.shields.io/github/v/release/BevalZ/pi-provider?display_name=tag&sort=semver)](https://github.com/BevalZ/pi-provider/releases)

面向 [Pi](https://github.com/earendil-works/pi-coding-agent) 的 Provider 管理扩展 —— 管理 `~/.pi/agent/models.json` 中的自定义供应商，并在写入前做 **能力自检** 与 **自适应 `compat` 改写**。

添加或编辑 provider 时，会探测端点并关闭不支持的能力（reasoning、`store`、developer role、错误的 max-tokens 字段等），使写入配置与网关真实能力一致。

## 安装

需要 [Pi coding agent](https://github.com/earendil-works/pi-coding-agent)。

```bash
pi install git:github.com/BevalZ/pi-provider
```

然后重启 Pi，或执行 `/reload`。

## 用法

```text
/provider                 交互管理菜单
/provider add             添加（保存前自检）
/provider edit [name]     编辑（保存时自检）
/provider check [name]    重新探测能力并改写 compat/reasoning
/provider copy [name]     复制为新名称
/provider remove          删除
/provider test            连通性与延迟测试
/provider status          查看详情 / 刷新
/provider archive         归档
/provider archived        查看归档 / 重新激活
/provider activate [name] 激活已归档的 provider
```

### 首次流程

```bash
# 1. 安装
pi install git:github.com/BevalZ/pi-provider

# 2. 添加
/provider add
#    名称 → Base URL → API key → API 类型 → Model ID → 输入类型
#    是否偏好 reasoning？（不支持会自动关闭）
#    自检后写入 models.json

# 3. 选用模型
/model
```

密钥建议用环境变量：API key 填 `$MY_PROVIDER_KEY`，再在 shell 中 export。

## 自检（OpenAI 系）

在 **add** / **edit 保存** / **check** 时，对 `openai-completions` 与 `openai-responses` 探测：

| 探测 | 自适应写入 |
|------|------------|
| `max_completion_tokens` vs `max_tokens` | `compat.maxTokensField` |
| `store` | `compat.supportsStore` |
| `stream_options.include_usage` | `compat.supportsUsageInStreaming` |
| `developer` role | `compat.supportsDeveloperRole` |
| `reasoning_effort` | `supportsReasoningEffort` + model `reasoning` + `thinkingLevelMap` |
| assistant 上的空 `reasoning_content` | `requiresReasoningContentOnAssistantMessages` |

不支持的能力会写成 `false` 并去掉 thinking map，避免 Pi 发送被拒参数。

Anthropic / Google / Mistral：目前仅连通性检查（详细 compat 探测仅 OpenAI 系）。

自检失败（鉴权 / 网络）时，仍可选择按 best-effort 保存。

## 管理范围

写入 `~/.pi/agent/models.json`：

- 活动 `providers`
- `archivedProviders`（软删除 / 恢复）

**不会**把 API key 发到你配置的端点以外的地方。

## 目录结构

```text
pi-provider/
  package.json
  LICENSE
  README.md
  README.zh-CN.md
  extensions/
    provider/
      index.ts          # /provider 命令
    _shared/
      box-drawing.ts
      enhanced-select.ts
      entity-crud.ts
      edit-menu.ts
      json-io.ts
      fetch-utils.ts
```

## 安全

- 优先用 `$ENV_VAR` 形式的 API key，避免明文写入 `models.json`
- 不要提交个人的 `models.json`
- 自检仅向**你配置的 base URL** 发送最小 chat 探测（`"hi"`，`max_tokens: 1`）

## 更新日志

### v1.0.0

- 交互式 `/provider` 管理（add / copy / edit / remove / test / status / archive）
- add、edit 保存与 `/provider check` 时的自适应能力自检
- OpenAI 系：max-tokens 字段、store、stream usage、developer role、reasoning 探测

## 致谢

本开源项目已链接并获 [LINUX DO](https://linux.do) 社区认可。

## 许可证

MIT — 见 [LICENSE](./LICENSE)。
