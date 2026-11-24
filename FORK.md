# 本地 fork 说明

上游：`dsh-cross-session@0.3.3`（npm，2026-08-26 发布）
fork 版本：`0.3.3-local.1`
目标运行时：**DSH 0.2.2-rc.5**

---

## 为什么 fork

上游 `lib/index.js` 这一行在 DSH ≥ 0.1.2-alpha.2 上必然失败：

```js
import { resolveSessionPreset } from '@deepseek-ai/dsh-agent-presets';
```

`@deepseek-ai/dsh-agent-presets` 在 0.1.2-alpha.2 被拆成 `dsh-agent-preset` +
`dsh-agent-preset-registry`，`resolveSessionPreset` 这个导出被移除，此后所有版本都没有。

版本时间线：

| 日期 | 事件 |
|---|---|
| 2026-08-21 | presets 0.1.1-rc.2 发布（API 还在） |
| 2026-08-26 | 上游插件 0.3.3 发布（当时正常） |
| 2026-08-30 | presets 0.1.2-alpha.2 发布（**移除该导出**） |
| 2026-11 | DSH 0.2.2-rc.5：全树已无该函数 |

---

## 改了什么

### 1. 新增 `lib/preset-compat.js`

把原实现搬了过来（7 行，零依赖）：

```js
export function resolveSessionPreset(session) {
  const events = Array.isArray(session?.events) ? session.events : [];
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type === 'agent-preset/selected') return event.data?.agentPreset;
  }
  return session?.header?.agentPreset;
}
```

兼容性依据：0.2.2 的 `dsh-agent-preset-registry` 仍在使用
`agent-preset/selected` 事件类型与 `agentPreset` 头部字段，因此行为等价。

### 2. `lib/index.js` 改 import

```diff
-import { resolveSessionPreset } from '@deepseek-ai/dsh-agent-presets';
+import { resolveSessionPreset } from './preset-compat.js';
```

调用点未改动（仍是 2 处：恢复会话时、spawn 子会话时）。

### 3. `package.json`

- `dependencies` 精确钉到宿主版本：`dsh-agent/llm/session/tools` = `0.2.2-rc.5`，`schemastery` = `3.19.0`
- 移除对 `@deepseek-ai/dsh-agent-presets` 与 `cordis` 的依赖
- `peerDependencies` 改为 `^0.2.2-rc.5`，以通过 DSH 0.2 的版本门禁

### 4. 补回 `inject` 声明（第二处，也是真正导致不挂载的原因）

上游在 `apply()` 里同步解析服务：

```js
const tools = ctx.get('tools');
const agents = ctx.get('agents');
if (!agents || typeof agents.create !== 'function' || typeof agents.resume !== 'function') {
  throw new Error('[dsh-cross-session] 需要宿主提供 agents 服务（create/resume）…');
}
```

DSH 0.2.2 里 `agents` 服务确实存在（`dsh-agent` 的 `super(ctx, "agents")`，且有
`async create(options)` / `async resume(options)`），但**组合顺序不保证它在 apply 时已就绪**，
于是插件抛错，启动时表现为 `dsh: warning: 1 entry did not activate`。

修复即回到 Cordis 的常规写法：

```js
export const inject = ['tools', 'agents'];
```

声明后 Cordis 会等两个服务就绪再调用 `apply`，与官方 `dsh-tool-subagent` 的
（`inject = ['tools','subagents','systemPrompt','sessionProjections']`）一致。

验证方式：在 headless profile 里加载后运行一次，`1 entry did not activate` 警告消失，
仅剩预期的 API key 报错，说明 `apply()` 已完整执行（5 个工具注册成功）。

---

## 安装方式

```powershell
dsh plugin --profile web add 'F:\examples\python\PancPathology\_plugins\dsh-cross-session'
```

装成 `link:` 依赖，所以**改这里的代码后重启 dsh web 即生效**，无需重装。

注意：`link:` 不会自动安装被链接包的依赖，首次需在本目录执行一次：

```powershell
npm install --omit=dev
```

## 回滚

```powershell
dsh plugin --profile web remove dsh-cross-session
```

## 上游修好后

若上游发布了适配 0.2.x 的版本，删除本 fork 依赖、改回 `dsh plugin add dsh-cross-session` 即可。
