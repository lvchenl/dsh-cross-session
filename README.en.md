# dsh-cross-session

Cross-session messaging plugin for DeepSeek Harness. **A functional replica of Codex
(ChatGPT Work) cross-thread task dispatch** (`codex_app__create_thread` /
`send_message_to_thread` / `read_thread` / `wait_threads`), built on DSH session
mechanics: **one session dispatches a task = a brand-new top-level session is created,
and when the task finishes, it sends the results back by itself.**

One-line principle: sending and replying are fully symmetric — delivery is just appending
a user-visible message to the target session (`agent.followup` / `steer`), so **whatever
you send over, comes back as the result.**

> 中文版（默认）：[README.md](README.md)

## Why

### The pain

| Without it | With it |
|---|---|
| Research, coding and review pile up in one session; context gets polluted | Each task gets its own clean session |
| "Parallel work" means many windows and manual copy-paste of tasks and results | One tool call dispatches; spawn returns immediately, does not block your turn |
| Dispatched work is a black box: is it running? where is the result? | Registry + `status`: running state, replies, model, reasoning effort at a glance |
| No reply channel between tasks; you have to go dig for results | Completed tasks reply automatically (delivered + wakes the creator) — you just see it |

### Concrete benefits

- **Hyperthreading**: `spawn` returns immediately; you keep working; many assistants run
  in parallel, whoever finishes replies first.
- **No lost messages**: sessions are top-level, durable (on disk); closed sessions are
  woken from disk; messages are queued before delivery.
- **Preemption**: when the target is busy, a message is injected right after the current
  step (not after the whole turn) — in agent-to-agent messaging, earlier information
  saves time and tokens.
- **Replies built in**: the task brief includes the protocol — on completion the worker
  MUST `cross_session_reply` its result to you (or to a third party via `reply_to`).
- **Model per task**: each task session can pick its own model / reasoning effort;
  defaults to inheriting from the caller.
- **Manageable**: `list` / `rename` / `archive` use the same channel as the GUI.

## Installation

```sh
# Option 1: normal users
dsh plugin --profile web add dsh-cross-session
# restart the dsh web host (or refresh the page) afterwards

# Option 2: local development (link)
pnpm --dir "$HOME/.dsh/profiles/web" link dsh-cross-session
# or symlink the plugin dir into $HOME/.dsh/profiles/web/node_modules/dsh-cross-session
```

Prerequisite: `pnpm` on PATH (`dsh plugin add` runs pnpm inside the profile directory).

## Quick start

```sh
# 1. Dispatch (returns immediately; session_id is what spawn returns)
cross_session_spawn {
  name: "research-assistant",
  task: "Research DeepSeek Harness plugin mechanics and summarize. Reply via cross_session_reply when done."
}

# 2. Don't wait — the session replies automatically; you'll see:
#   [cross-session] Reply from session session-xxx: ...

# 3. Overview anytime
cross_session_status
```

## Example scenarios

### Scenario A: development — three-way parallel (recommended)

Dispatch three assistants for one project, fully independent:

```sh
cross_session_spawn {
  name: "compat-research",
  task: "Use npm view to verify each dependency version resolves; output conclusions with evidence. Reply via cross_session_reply when done."
}

cross_session_spawn {
  name: "code-review",
  task: "Review lib/index.js for portability: hardcoded paths, platform-specific code, degraded service handling. List issues with severity. Reply via cross_session_reply when done."
}

cross_session_spawn {
  name: "release-rehearsal",
  task: "Rehearse the release flow in dev/: check -> pack -> list artifact names and versions. Reply via cross_session_reply when done."
}
```

Keep working on your own tasks. Each assistant replies on completion; mid-way you can check
progress or aggregate:

```sh
cross_session_status                    # all task sessions: running state + latest reply
cross_session_read { session_id: "session-xxx" }   # read a worker's work log
```

Add follow-up work without opening a new session (preempts by default — a busy worker
receives it at the next step):

```sh
cross_session_send {
  session_id: "session-xxx",
  message: "One more item: confirm the engines field ships with the package. Reply when done."
}
```

Route the result to a THIRD session (e.g., subtask reports to "main agent"):

```sh
cross_session_spawn {
  name: "subtask",
  task: "……",
  reply_to: "session-main-agent"
}
```

### Scenario B: documentation work (no code)

Write a research report — same pattern, no code involved:

```sh
# 1. Researcher: gather material and reply
cross_session_spawn {
  name: "researcher",
  task: "Gather material from the links below and organize into key points by topic. Reply via cross_session_reply when done."
}

# 2. Once you have the material, ask it to expand into a report
cross_session_send {
  session_id: "session-researcher",
  message: "Please expand the material into a 3000-word report with three sections. Reply when done."
}

# 3. Proofreader: check typos, structure, consistency; reply
cross_session_spawn {
  name: "proofreader",
  task: "Check the report for structure and typos; give a list of changes. Reply via cross_session_reply when done."
}
```

Dispatch, follow-up, proofread — the exact same three moves as coding: spawn / send / collect replies.

### Scenario C: when you don't want to wake it

```sh
# Queue only, no wake (handled after the current turn, or next time someone wakes it)
cross_session_send { session_id: "session-xxx", message: "No rush, do it later", wake: false }

# No preemption: wait until the target finishes its whole turn
cross_session_send { session_id: "session-xxx", message: "Later task", interrupt: false }
```

### Scenario D: housekeeping

```sh
cross_session_list { limit: 50, include_archived: true }   # all top-level sessions
cross_session_rename { session_id: "session-xxx", name: "New-name" }
cross_session_archive { session_id: "session-xxx" }        # archive (same channel as GUI right-click; restorable)
```

## Tools

| Tool | What it does |
|---|---|
| `cross_session_spawn` | Create a fresh top-level session and dispatch the task, return immediately; `reply_to` routes results to another session; `model` / `reasoning_effort` pick model and effort (default: inherit caller) |
| `cross_session_send` | Send a message to any session (default **preempt**; `interrupt: false` queues until turn end; `wake: false` delivers without waking); closed sessions are woken from disk |
| `cross_session_reply` | Worker-only: reply the result to a session (default **preempt** delivery + wake) |
| `cross_session_status` | Registry overview: running state, reply count, latest reply, reply target, model / reasoning effort |
| `cross_session_read` | Read a session's recent work log (user messages + assistant replies); reads from disk when closed |
| `cross_session_list` | List all top-level sessions (name / session id / model / effort), optionally archived |
| `cross_session_rename` | Rename any session (writes a pinning event for closed sessions) |
| `cross_session_broadcast` | Send DIFFERENT messages to many sessions at once (independent tasks), reporting each result |
| `cross_session_archive` | Archive any session (official channel; persistent, idempotent, restorable) |

## Delivery semantics (preemption)

All deliveries **preempt by default (next-step)**: when the target is busy, the message is
injected immediately after the current step (idle targets start a fresh turn at once).
`interrupt: false` switches to queueing (next-turn, after the whole turn). Backed by DSH
native `steer` / `followup` / `inject`; hosts without `steer` degrade to `followup` — no message lost.

## Protocol

The spawn task brief instructs the new session: **on completion call `cross_session_reply`
(`captain_session_id` = the creating session, or the session given by `reply_to`) to send
back the result**; the target sees `[cross-session] Reply from session <id>: …` in its own chat.

State is recorded in `<workspace>/.cross-session/registry.json` (`stateDir` configurable).

## Configuration

| Key | Default | Description |
|---|---|---|
| `stateDir` | `.cross-session` | Registry directory (relative to workspace root) |

## Compatibility & troubleshooting

- **Host version**: compatible with dsh **0.1.x** (`@deepseek-ai/dsh-*` 0.1.1-rc.2 line).
  If cross-session features misbehave after a host upgrade, the plugin prints a
  `[dsh-cross-session]`-prefixed warning; upgrade this plugin to the latest version if so.
- **Node**: **≥ 18** (`engines`); CI runs Node 24.
- **Profile requirement**: needs `tools` / `agents` services from `dsh-base`
  (all standard profiles: web / tui / headless). `agentPresets` and `workspaceRegistry`
  exist only in web-app-style profiles — outside web, `archive` and workspace attachment
  degrade or error clearly; other tools keep working.
- **Prerequisite**: `pnpm` on PATH; **restart the host** (or refresh) after install.
- **Registry**: write failures do not block operations; only a `[dsh-cross-session]` warning.

## Version history

| Version | Content |
|---|---|
| 0.3.3 | README rewrite: Chinese primary + English; explicit Codex replication note |
| 0.3.2 | Delivery semantics: default **preemption** (`steer`/next-step); `interrupt` param for `send`/`broadcast`; fixed `wake: false` not taking effect |
| 0.3.1 | P2-6: removed `inject` blocking; explicit `ctx.get` validation with clear errors |
| 0.3.0 | Compatibility hardening (audit fixes): startup guard, atomic registry write + write-failure degrade, cwd normalization, engines |
| 0.2.9 | `status` shows reply target and model/effort; CI release pipeline (Trusted Publishing / OIDC) |
| 0.2.8 | `spawn` supports `model` / `reasoning_effort` (default: inherit caller) |
| 0.2.7 | `cross_session_archive` |
| 0.2.6 | `cross_session_read` reads closed sessions from disk |
| 0.2.5 | `reply_to` three-way routing on spawn/send/broadcast; reply auto-wake fix |
| 0.2.4 | `cross_session_reply` wakes closed targets from disk |
| 0.2.3 | `cross_session_broadcast` one-to-many |
| 0.2.2 | `cross_session_rename` |
| 0.2.1 | `cross_session_list` lossless output (empty-session crash fix) |

## Known limitations

- `reply_to` on `broadcast` / `send` is a **task-level directive**: the worker must cooperate
  by calling `cross_session_reply` (protocol is built into the spawn brief).
- No Web UI panel; use `cross_session_status` for state.
- Valid model / reasoning-effort values are adapter-defined (this project uses
  `off/low/medium/high/max`); invalid values error when the session starts a request.

## License

[MIT](./LICENSE)
