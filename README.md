# dsh-cross-session · 跨会话通信

[DeepSeek Harness](https://www.deepseek.com/) 的跨会话消息插件（B 形态：**顶层持久会话**）。

一个会话可以**创建全新的顶层会话**（与侧边栏会话同等级、持久、可复用），把任务作为消息投递过去并**立即唤醒它执行**，自己**不等待**、可以继续做其他工作；任务会话完成后，通过**同一条通道**把结果回复回来。发送与回复走完全对称的原语（`agent.followup` 一条 user 消息），因此"消息怎么发过去，就怎么回过来"。

## 特性

- **创建持久会话**（`spawn`）：新会话与侧边栏会话同等级，未结束前一直在；可指定 **model / reasoning_effort**（默认继承调用者），可指定 **reply_to** 把结果回给第三方会话
- **任意会话可达**：`send` / `reply` / `read` / `rename` / `archive` 对**未打开的会话同样有效**（自动从磁盘叫醒，或直接读取磁盘日志，无需先打开）
- **一对多广播**（`broadcast`）：一次给多个会话发**不同**任务，逐个投递并报告结果
- **状态登记**：任务会话、回信对象（leadSessionId）、回复记录持久化在 `<工作区>/.cross-session/registry.json`
- **与 GUI 同源**：`rename` 走官方 SessionTitleService，`archive` 走官方 workspaceRegistry.archiveSession（持久化、幂等、可恢复）

## 安装

### 方式一：npm（发布后）

```sh
dsh plugin --profile web add dsh-cross-session
# 重启 dsh web 宿主（或刷新页面）后生效
```

### 方式二：本地开发（链接）

```sh
# 在 profile 的 node_modules 里指向插件目录（Windows junction / Linux symlink）
pnpm --dir "$HOME/.dsh/profiles/web" link dsh-cross-session
# 或直接把插件目录链接到 $HOME/.dsh/profiles/web/node_modules/dsh-cross-session
```

## 工具

| 工具 | 作用 |
|---|---|
| `cross_session_spawn` | 创建全新顶层会话并投递任务，立即返回（不等待执行）；`reply_to` 可指定结果回给第三方会话；`model` / `reasoning_effort` 可指定新会话的模型与推理程度（默认继承调用者） |
| `cross_session_send` | 给任意会话发消息（默认**插队**：忙碌时也在当前步骤结束后立即注入；`interrupt: false` 则排队等整轮结束；`wake: false` 则仅投递不唤醒）；未打开的会话自动从磁盘叫醒后投递；`reply_to` 可指定本次任务结果回给谁 |
| `cross_session_reply` | 任务会话专用：把结果回复给指定会话（默认**插队**投递并唤醒它）；目标未打开时自动从磁盘叫醒 |
| `cross_session_status` | 查看登记的任务会话：运行状态、回复次数、最近回复摘要 |
| `cross_session_read` | 读取某个会话最近的工作过程/结果（用户消息 + 助手回复）；未打开的从磁盘直接读取 |
| `cross_session_list` | 快速列出所有顶层会话（名称 + 会话 id + 模型名称 + 推理程度），可选含已归档 |
| `cross_session_rename` | 修改任意会话的名称：活跃会话走官方 rename，未打开的会话直接落盘事件（钉住标题） |
| `cross_session_broadcast` | 一次给多个会话发不同消息（各自独立任务），逐个投递并报告结果；每个目标可带 `reply_to` 指定回信对象、`interrupt` 控制是否插队 |

## 投递语义（插队）

所有跨会话投递默认**插队（next-step）**：目标会话忙碌时，消息在当前步骤结束后立即
注入（空闲时同样立刻开新轮）——消息越早到位，越能省时间与 token。`interrupt: false`
改为排队（next-turn，等目标当前整轮结束）。底层使用 DSH 原生 `steer`/`followup`/
`inject` 语义（对不支持 `steer` 的宿主自动降级为 followup，不丢消息）。
| `cross_session_archive` | 归档任意会话（与 GUI 右键归档同一条官方通道，持久化、幂等、可恢复） |

## 协议

`spawn` 时注入的任务消息会指示新会话：**工作完成后调用 `cross_session_reply`
（`captain_session_id` = 创建者会话 id，或 `reply_to` 指定的会话）回复结果**；
目标会话被唤醒后，在其对话中会看到 `[cross-session] 来自会话 <id> 的回复：…`。

状态登记在 `<工作区>/.cross-session/registry.json`（`stateDir` 可配置）。

## 示例

```sh
# 列出一个 "调研助手"，让它完成后回信给我
cross_session_spawn {
  name: "调研助手",
  task: "调研 DeepSeek Harness 的插件机制，输出总结",
  reasoning_effort: "high"        # 可选：新会话的推理程度
}

# 列出所有顶层会话（名称 / 会话 id / 模型 / 推理程度）
cross_session_list { "limit": 50, "include_archived": true }

# 给多个会话派不同任务
cross_session_broadcast {
  targets: [
    { session_id: "session-a", message: "任务A" },
    { session_id: "session-b", message: "任务B", reply_to: "session-a" }
  ]
}

# 修改任意会话名称
cross_session_rename { session_id: "session-a", name: "新名字" }

# 归档测试会话
cross_session_archive { session_id: "session-a" }
```

## 配置

```yaml
- id: cross-session
  name: 'dsh-cross-session'
  config:
    stateDir: .cross-session
```

## 版本历史

| 版本 | 内容 |
|---|---|
| 0.3.2 | 投递语义升级：全部默认**插队**（DSH 原生 `steer`/next-step）；`send`/`broadcast` 新增 `interrupt` 参数；修复 `wake: false` 原先未真正生效的问题 |
| 0.3.1 | P2-6：移除 `inject: ['tools','agents']`（不再阻塞 profile 启动），改为 apply() 显式 `ctx.get` 解析 tools/agents 并清晰报错 |
| 0.3.0 | 兼容性加固（审计修复）：启动守卫、登记表原子写 + 写失败降级、list cwd 规范化、engines 声明、README 兼容性章节 |
| 0.2.9 | `cross_session_status` 显示回信对象（leadSessionId）与模型/推理程度；CI 发布流水线（Trusted Publishing / OIDC） |
| 0.2.8 | `spawn` 支持 `model` / `reasoning_effort` 指定（默认继承调用者） |
| 0.2.7 | `cross_session_archive` 归档工具（官方 workspaceRegistry 通道） |
| 0.2.6 | `cross_session_read` 未打开的会话改为从磁盘直接读取 |
| 0.2.5 | `reply_to` 三方路由覆盖 spawn / send / broadcast；reply 自动叫醒（修复） |
| 0.2.4 | `cross_session_reply` 目标未打开时自动从磁盘叫醒 |
| 0.2.3 | `cross_session_broadcast` 一对多广播 |
| 0.2.2 | `cross_session_rename` 任意会话改名 |
| 0.2.1 | `cross_session_list` 输出 lossless（修复空会话崩溃） |

## 已知限制

- `broadcast` / `send` 的 `reply_to` 是**任务级指令**：需要任务会话配合执行
  `cross_session_reply` 才能回信（协议已内置到 spawn 的任务书里）。
- 没有 Web UI 面板；状态通过 `cross_session_status` 工具查询。
- 模型/推理程度的合法取值由 LLM 适配器定义（本项目用 `off/low/medium/high/max`），
  不合法值会在会话发起请求时报错。

## 兼容性与排障

- **宿主版本**：兼容 dsh **0.1.x**（`@deepseek-ai/dsh-*` 0.1.1-rc.2 系）。宿主升级后若
  出现跨会话能力异常，插件启动时会打印 `[dsh-cross-session]` 前缀的告警；如有告警请
  升级本插件到最新版（跟随 dsh 发布节奏）。
- **Node**：需要 **≥ 18**（`engines` 声明）；CI 使用 Node 24。
- **profile 要求**：需要 `dsh-base` 提供的 `tools` / `agents` 服务（web/tui/headless
  三个标准 profile 均满足）。`agentPresets` 与 `workspaceRegistry` 仅在 web-app 类
  profile 中存在——非 web profile 下 `archive` 与工作区依附会降级/报清晰错误，其余工具可用。
- **安装前置**：`dsh plugin add` 底层是 profile 目录内的 pnpm，本机 PATH 需有
  `pnpm`；安装后**重启宿主**（或刷新页面）生效。
- **登记表**：写入 `<工作区>/.cross-session/registry.json`（`stateDir` 可配置）；
  写失败不阻塞业务操作，仅打 `[dsh-cross-session]` 告警。

## 许可证

[MIT](./LICENSE)
