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

## 完整菜单说明

以下与输入 `/provider`（或带子命令）后的交互 TUI 一致。

### 主菜单 — `Provider management`

| 菜单项 | 作用 |
|--------|------|
| **Add** | 新建 provider；保存前自检 |
| **Copy** | 深拷贝已有 provider 为新名字 |
| **Edit** | 编辑字段；保存时自检 |
| **Remove** | 从活动 `providers` 硬删除（不可恢复） |
| **Test** | 连通性 / 延迟 / 远程模型列表 |
| **Check** | 重新探测能力并改写 `compat` / `reasoning` |
| **Status** | 完整详情 + 再测一次 |
| **Archive** | 活动 → `archivedProviders` |
| **Archived** | 浏览归档：详情 / 恢复 / 永久删除 |

---

### Add（添加）流程

| 步骤 | 界面 | 说明 |
|------|------|------|
| 1 | 输入 **Provider name** | `models.json` 中的配置 key |
| 2 | 若名称已存在 | 确认是否覆盖 |
| 3 | 若名称在归档中 | 是否改为 **激活** 归档项 |
| 4 | 输入 **Base URL** | 如 `https://api.example.com/v1` |
| 5 | 输入 **API key** | 支持 `$ENV_VAR` |
| 6 | 选择 **API type** | 见下表 |
| 7 | 输入 **Model ID** | 如 `gpt-4` |
| 8 | 输入 **Display name** | 可空，默认用 Model ID |
| 9 | 选择 **Input types** | Text / Text + Image |
| 10 | 确认 **Reasoning** | 是否偏好 extended thinking（不支持会自动关） |
| 11 | **Self-checking…** | 探测端点并改写 `compat` |
| 12 | 自检失败时 | 确认是否仍按 best-effort 保存 |

**API type**

| 选项 | 含义 |
|------|------|
| Openai-completions (OpenAI 兼容) | Chat Completions（最常见中转） |
| Anthropic-messages (Claude 兼容) | Anthropic Messages |
| Openai-responses | OpenAI Responses API |
| Google-generative-ai | Google Generative AI |
| Mistral-conversations | Mistral |

**Input types**

| 选项 | 含义 |
|------|------|
| Text | 仅文本 |
| Text + Image | 文本 + 图片 |

---

### Copy（复制）流程

| 步骤 | 说明 |
|------|------|
| 选择源 provider | 支持模糊搜索 |
| 输入新名字 | 目标配置 key |
| 若目标已存在 | 确认覆盖 |
| 若目标在归档 | 需先激活或删除归档项 |
| 深拷贝写入 | 含 models、compat、key、headers 等 |

---

### Edit 菜单 — `Edit provider: <name>`

| 字段 | 功能 |
|------|------|
| **Config name** | 重命名 provider key |
| **Endpoint** | 修改 `baseUrl` |
| **API key** | 修改密钥（回车保留原值） |
| **Name field** | 显示名；输入 `-` 清空 |
| **API type** | 与 Add 相同的 API type 菜单 |
| **Models** | 选择模型 → 进入模型编辑 |
| **s Save** | 自检后保存 |
| **x Discard** | 丢弃修改 |

**Edit model**（选中某个 model 后）

| 字段 | 功能 |
|------|------|
| **ID** | Model id |
| **Name** | 显示名 |
| **Context window** | 上下文 token |
| **Max output** | 最大输出 token |
| **s Save / x Back** | 保存模型草稿或返回 |

保存 provider 时：自检 → 失败可选仍保存 → 写 `models.json` → refresh registry。

---

### Remove（删除）

| 步骤 | 说明 |
|------|------|
| 选择 provider | |
| **Confirm deletion** | 从活动列表永久删除 |
| 提示 | 以后可能还要用请优先 **Archive** |

---

### Test（测试）结果

| 步骤 | 说明 |
|------|------|
| 选择 provider | |
| 探测请求 | OpenAI 系流式 chat / Anthropic messages 等 |
| 结果页 | 状态、延迟、TTFB、Connect |
| 远程 `/models` | 多列列表；`[*]` = 当前已注册 |

---

### Check（能力再探测）

| 步骤 | 说明 |
|------|------|
| 选择 provider | |
| **Reasoning preference** | 是否仍尝试开启 extended thinking |
| **Self-checking…** | 与 Add 相同的探测 |
| 失败时 | 可选写入 best-effort 标志 |
| 落盘 | 更新 `compat` 与各 model 的 `reasoning` / `thinkingLevelMap` |

---

### Status 视图 — `Status: <name>`

展示内容：

- Provider / Endpoint / API / API key 预览 / Status
- **Performance**：Latency、TTFB、Connect
- **Compatibility**：当前 `compat` 键值
- **Models**：reasoning、input、context、max output、thinking map
- **Remote models**：云端列表 vs 已注册

**Next action**

| 选项 | 功能 |
|------|------|
| **Refresh** | 重测当前 provider |
| **Back** | 选择其他 provider |
| **Exit** | 返回聊天 |

---

### Archive（归档）

| 步骤 | 说明 |
|------|------|
| 选择活动 provider | |
| 确认 | |
| 效果 | 移入 `archivedProviders`（带 `archivedAt`），并从活动列表移除 |

---

### Archived（归档浏览器）

| 操作 | 功能 |
|------|------|
| 选择归档项 | 支持模糊列表 |
| **Details** | 查看 endpoint、API、models、归档时间 |
| **Restore** | 重新激活（同 Activate） |
| **Delete** | 从归档中永久删除 |
| **← Back** | 退出操作菜单 |

---

### Activate（激活归档）

| 步骤 | 说明 |
|------|------|
| 选择归档名（或命令行传名） | |
| 若活动侧同名冲突 | 确认覆盖 |
| 效果 | 去掉 `archivedAt`，写回 `providers`，并从归档删除 |

命令别名：`activate` · `unarchive` · `restore`

---

### 命令速查

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
/provider archived   # 或: list
/provider activate [name]
```

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
  scripts/
    sync-shared.mjs   # 与本机 Pi 安装保持 vendored 文件同步
    detect-test.mjs   # 结构化错误判定的冒烟测试
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

## 开发

包内 vendored 了 `provider/index.ts` 和几个 `_shared/*` helper，而这些文件在本机
Pi 安装（`~/.pi/agent/extensions`）里是就地编辑的，时间久了两边会漂移。用同步脚本
保持一致：

```bash
npm run sync-shared     # 从本机 Pi 安装（权威源）拷贝到包
npm run check-shared    # 有任何 vendored 文件不一致则 exit 1（CI / 发布前）
npm test                # 运行结构化错误判定的冒烟测试
```

源解析顺序：`--source <dir>` → `$PI_EXTENSIONS_DIR` → `~/.pi/agent/extensions`。
发布打 tag 前先跑 `check-shared`，确保发布文件不落后于本机改动。

## 安全

- 优先用 `$ENV_VAR` 形式的 API key，避免明文写入 `models.json`
- 不要提交个人的 `models.json`
- 自检仅向**你配置的 base URL** 发送最小 chat 探测（`"hi"`，`max_tokens: 1`）

## 更新日志

### v1.1.0

- 自检改用**结构化错误判定**：优先解析 OpenAI 风格的 `error.param` / `error.code` / `error.type`，正则仅作兜底，减少跨网关误判
- `sync-shared` 脚本：防止 vendored `_shared` 与本机漂移
- `detect-test` 冒烟测试：覆盖限流 / 模型不存在等易误判场景

### v1.0.0

- 交互式 `/provider` 管理（add / copy / edit / remove / test / status / archive）
- add、edit 保存与 `/provider check` 时的自适应能力自检
- OpenAI 系：max-tokens 字段、store、stream usage、developer role、reasoning 探测

## 致谢

本开源项目已链接并获 [LINUX DO](https://linux.do) 社区认可。

## 许可证

MIT — 见 [LICENSE](./LICENSE)。
