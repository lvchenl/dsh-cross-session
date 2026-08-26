# dsh-cross-session（跨会话通信）

DeepSeek Harness 的跨会话消息插件。**功能复刻自 Codex（ChatGPT Work）的跨线程任务调度**
（`codex_app__create_thread` / `send_message_to_thread` / `read_thread` / `wait_threads`），
用 DSH 的会话机制实现：**一个会话派任务 = 创建一个全新的顶层会话，任务完成后它自己把结果送回来。**

一句话原理：发送与回复完全对称——投递就是给目标会话追加一条用户可见消息
（`agent.followup` / `steer`），所以**消息发过去，成果就回来**。

> English version: [README.en.md](README.en.md)

## 为什么做这个

### 痛点

| 没有它 | 有了它 |
|---|---|
| 一个会话里任务越堆越多：调研、写代码、审查混在一起，上下文互相污染 | 每个任务一个独立会话，上下文干净 |
| 想并行干活只能开好几个窗口，手动复制粘贴任务和结果 | 一条工具调用派活，spawn 立即返回，不占你的轮 |
| 派出去的活是黑盒：不知道在不在跑、结果在哪 | 登记表 + `status`：运行状态、回信、模型、推理程度一目了然 |
| 任务间没有"回信"通道，结果要你主动去翻 | 任务完成自动回信（送达 + 叫醒创建者），你直接看到 |

### 好处，具体说

- **超线程**：`spawn` 即返回，你继续干别的；多个助手并行跑，谁先完谁先回。
- **不丢消息**：会话是顶层、持久的（落盘），关闭了也能从磁盘叫醒；消息先排队后送达。
- **插队语义**：目标会话忙碌时，消息在当前步骤结束后**立即注入**（不是等它整轮跑完）——agent 之间的信息越早到位，越省时间和 token。
- **可回信**：任务书里协议已内置——工作完成必须 `cross_session_reply` 把结果回给你（或回给第三方 `reply_to`）。
- **可指定模型**：每个任务会话可指定模型/推理程度，默认继承调用者。
- **能管理**：`list` / `rename` / `archive` 与 GUI 同通道，会话不失控。

## 安装

```sh
# 方式一：普通用户
dsh plugin --profile web add dsh-cross-session
# 重启 dsh web 宿主（或刷新页面）后生效

# 方式二：本地开发（链接）
pnpm --dir "$HOME/.dsh/profiles/web" link dsh-cross-session
# 或直接把插件目录链接到 $HOME/.dsh/profiles/web/node_modules/dsh-cross-session
```

前置：本机 PATH 有 `pnpm`（`dsh plugin add` 底层是 profile 目录内的 pnpm）。

## 快速上手

```sh
# 1. 派活（立即返回，session_id 是 spawn 返回的）
cross_session_spawn {
  name: "调研助手",
  task: "调研 DeepSeek Harness 的插件机制，输出总结。完成后调用 cross_session_reply 回复。"
}

# 2. 不用等——完成后它会自动回信，你在对话里看到：
#   [cross-session] 来自会话 session-xxx 的回复：……

# 3. 任何时候查总览
cross_session_status
```

## 场景示例

### 场景 A：开发项目——三路并行（推荐用法）

你在 DeepSeekHarness 项目里，一口气派三个助手，各自独立、互不干扰：

```sh
cross_session_spawn {
  name: "兼容性调研",
  task: "用 npm view 逐一确认依赖版本可解析性，输出结论与证据。完成后 cross_session_reply 回复。"
}

cross_session_spawn {
  name: "代码审查",
  task: "审查 lib/index.js 的可移植性：硬编码路径、平台特化、服务缺失降级。逐条列出问题与严重级别。完成后 cross_session_reply 回复。"
}

cross_session_spawn {
  name: "发布演练",
  task: "在 dev/ 目录演练发布流程：校验 → 打包 → 列出发布物与版本号。完成后 cross_session_reply 回复。"
}
```

你继续做自己的事。三个助手完成后会各自回信；中途要看进度或汇总：

```sh
cross_session_status                    # 全部任务会话：运行状态 + 最近回复
cross_session_read { session_id: "session-xxx" }   # 读某个助手的工作过程
```

中途追加任务（不用新开会话，且默认插队——正忙的助手也会在下一步收到）：

```sh
cross_session_send {
  session_id: "session-xxx",
  message: "再补一项：确认 engines 字段已随包发布。完成后回复我。"
}
```

让结果**回给另一个会话**（三方路由，例如让子任务汇报给"主 agent"）：

```sh
cross_session_spawn {
  name: "子任务",
  task: "……",
  reply_to: "session-主agent"
}
```

### 场景 B：文档工作（非开发）

写一份调研报告，全程不碰代码，同一个套路：

```sh
# ① 资料员：收集素材并回信（session_id 用 spawn 返回的 id）
cross_session_spawn {
  name: "资料员",
  task: "根据以下链接收集素材，按主题整理成要点列表。完成后 cross_session_reply 回复。"
}

# ② 拿到素材后，让它继续扩写成报告
cross_session_send {
  session_id: "session-资料员",
  message: "请把素材扩展成 3000 字报告，分三节，完成后回复我。"
}

# ③ 校对员：查错别字、结构、一致性，回信
cross_session_spawn {
  name: "校对员",
  task: "检查报告的结构与错别字，给出修改建议清单。完成后 cross_session_reply 回复。"
}
```

派活、接力、校对——**与写代码完全相同的三个动作：spawn / send / 收回信**。

### 场景 C：不想被唤醒时

```sh
# 只排队不唤醒（目标当前工作结束后再处理，或等下次有人叫它）
cross_session_send { session_id: "session-xxx", message: "不急，回头做", wake: false }

# 不插队：等目标整轮跑完再处理
cross_session_send { session_id: "session-xxx", message: "稍后任务", interrupt: false }
```

### 场景 D：管理清理

```sh
cross_session_list { limit: 50, include_archived: true }   # 所有顶层会话
cross_session_rename { session_id: "session-xxx", name: "新名字" }
cross_session_archive { session_id: "session-xxx" }        # 归档（与 GUI 右键同通道，可恢复）
```

## 工具一览

| 工具 | 作用 |
|---|---|
| `cross_session_spawn` | 创建全新顶层会话并投递任务，立即返回；`reply_to` 指定结果回给谁；`model` / `reasoning_effort` 指定模型与推理程度（默认继承调用者） |
| `cross_session_send` | 给任意会话发消息（默认**插队**；`interrupt: false` 排队等整轮；`wake: false` 只投递不唤醒）；未打开会话自动从磁盘叫醒 |
| `cross_session_reply` | 任务会话专用：把结果回复给指定会话（默认**插队**投递并叫醒） |
| `cross_session_status` | 登记总览：运行状态、回复次数、最近回复、回信对象、模型/推理程度 |
| `cross_session_read` | 读取某会话最近工作过程（用户消息 + 助手回复）；未打开的从磁盘直读 |
| `cross_session_list` | 列出所有顶层会话（名称/会话 id/模型/推理程度），可选含已归档 |
| `cross_session_rename` | 修改任意会话名称（未打开的写事件钉住标题） |
| `cross_session_broadcast` | 一次给多个会话发不同消息（各自独立任务），逐个报告结果 |
| `cross_session_archive` | 归档任意会话（官方通道，持久化、幂等、可恢复） |

## 投递语义（插队）

所有投递**默认插队（next-step）**：目标忙碌时，消息在当前步骤结束后立即注入（空闲时同样立刻开新轮）。
`interrupt: false` 改为排队（next-turn，等当前整轮结束）。底层用 DSH 原生 `steer` / `followup` / `inject`；
不支持 `steer` 的宿主自动降级为 `followup`，不丢消息。

## 协议

`spawn` 时注入的任务消息会指示新会话：**工作完成后调用 `cross_session_reply`
（`captain_session_id` = 创建者会话，或 `reply_to` 指定的会话）回复结果**；
目标会话在自己的对话里会看到 `[cross-session] 来自会话 <id> 的回复：…`。

状态登记在 `<工作区>/.cross-session/registry.json`（`stateDir` 可配置）。

## 配置

| 项 | 默认 | 说明 |
|---|---|---|
| `stateDir` | `.cross-session` | 登记表所在目录（相对工作区根） |

## 兼容性与排障

- **宿主版本**：兼容 dsh **0.1.x**（`@deepseek-ai/dsh-*` 0.1.1-rc.2 系）。宿主升级后若跨会话能力异常，
  插件启动时会打印 `[dsh-cross-session]` 前缀告警；如有告警请升级本插件到最新版。
- **Node**：需要 **≥ 18**（`engines` 声明）；CI 使用 Node 24。
- **profile 要求**：需要 `dsh-base` 提供的 `tools` / `agents` 服务（web/tui/headless 标准 profile 均满足）。
  `agentPresets` 与 `workspaceRegistry` 仅 web-app 类 profile 存在——非 web profile 下 `archive`
  与工作区依附会降级/报清晰错误，其余工具可用。
- **安装前置**：PATH 有 `pnpm`；安装后**重启宿主**（或刷新页面）生效。
- **登记表**：写入失败不阻塞业务操作，仅打 `[dsh-cross-session]` 告警。

## 版本历史

| 版本 | 内容 |
|---|---|
| 0.3.3 | README 重写：中文主版 + 英文版；明确复刻自 Codex 跨线程任务调度 |
| 0.3.2 | 投递语义升级：全部默认**插队**（`steer`/next-step）；`send`/`broadcast` 新增 `interrupt`；修复 `wake: false` 未生效问题 |
| 0.3.1 | P2-6：移除 `inject` 阻塞，改为 apply() 显式 `ctx.get` 校验并清晰报错 |
| 0.3.0 | 兼容性加固（审计修复）：启动守卫、登记表原子写 + 写失败降级、list cwd 规范化、engines 声明 |
| 0.2.9 | `status` 显示回信对象与模型/推理程度；CI 发布流水线（Trusted Publishing / OIDC） |
| 0.2.8 | `spawn` 支持 `model` / `reasoning_effort`（默认继承调用者） |
| 0.2.7 | `cross_session_archive` 归档工具 |
| 0.2.6 | `cross_session_read` 未打开会话改为磁盘直读 |
| 0.2.5 | `reply_to` 三方路由覆盖 spawn/send/broadcast；reply 自动叫醒 |
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

## 许可证

[MIT](./LICENSE)
