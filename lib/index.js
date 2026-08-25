/**
 * dsh-cross-session — 跨会话消息（B 形态：顶层持久会话）。
 *
 * 宿主平面插件：把 `cross_session_*` 工具注册进共享 `tools` 注册表。
 * 任意会话都能：
 *   - cross_session_spawn  创建全新的顶层会话（与侧边栏会话同等级、持久、可复用），
 *                           立刻把任务投递过去并唤醒它，自己不等待、可以继续干别的；
 *   - cross_session_send   给任意已打开的会话发消息（唤醒可选，默认为真）；
 *   - cross_session_reply  会话完成工作后，通过同一条通道把结果回复给指定会话
 *                           （与"发过去"完全对称：都是 followup 一条 user 消息）;
 *   - cross_session_status 查看所有会话协作的登记状态与未读回复；
 *   - cross_session_read   读取某个会话最近的工作过程/结果（它的事件表层）。
 *
 * 安装（bundle）：`dsh plugin --profile <name> add <本包路径>`。bundle patch 把
 * 本插件行挂进宿主组合；工具注册进共享 tools 注册表，因此 profile 的每个会话
 * 都能看到它们。
 *
 * @module dsh-cross-session
 */
import { randomUUID } from 'node:crypto';
import z from '@deepseek-ai/schemastery';
import { installModelSelection } from '@deepseek-ai/dsh-agent';
import { resolveSessionPreset } from '@deepseek-ai/dsh-agent-presets';
import { createUserMessage, ReasoningEffortId } from '@deepseek-ai/dsh-llm';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { SessionId } from '@deepseek-ai/dsh-session';
import { withRegistry } from './state.js';

/** 稳定 Cordis 插件名。 */
export const name = 'cross-session';

/**
 * 规范化 cwd 用于跨平台/跨书写风格的字符串比较（P2-3 修复）。
 * Windows 忽略大小写与尾分隔符差异；其余平台仅去尾分隔符。
 * @param {string | undefined} p
 * @returns {string}
 */
function normalizeCwd(p) {
  if (!p) return '';
  const trimmed = p.endsWith('/') || p.endsWith('\\') ? p.slice(0, -1) : p;
  return process.platform === 'win32' ? trimmed.toLowerCase() : trimmed;
}

/** 登记表写入的安全包装：写失败只警告不抛出（副作用已完成，不让调用方误判重试）。 */
async function safeRegistry(workspace, stateDir, mutate, label) {
  try {
    await withRegistry(workspace, stateDir, mutate);
  } catch (error) {
    console.warn(`[dsh-cross-session] 登记表写入失败（${label}）：${error instanceof Error ? error.message : String(error)}`);
  }
}

/** 插件配置。 */
export const Config = z.object({
  stateDir: z.string().default('.cross-session'),
});

/** 提取调用者 Agent，缺失时报错。 */
function requireAgent(exec) {
  if (!exec.agent) {
    throw new Error('cross_session 工具需要一个调用中的 Agent（exec.agent 缺失）');
  }
  return exec.agent;
}

/** 调用者会话的工作区目录。 */
function workspaceOf(agent) {
  return agent.session.header.cwd ?? process.cwd();
}

/** 收紧成 lossless-JSON 安全的字符串或 null（undefined / 对象 / Date 一律转 null）。 */
function textOrNull(value) {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return null;
}

/** 收紧成 lossless-JSON 安全的有限数字或 null。 */
function numberOrNull(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return null;
}

/** 当前模型路由选择（可为空）。 */
function currentSelection(ctx) {
  const svc = ctx.get('agentDefaultModel');
  if (svc && typeof svc.currentSelection === 'function') {
    return svc.currentSelection() ?? undefined;
  }
  return undefined;
}

/**
 * 为新会话组合 preset（挂工具等）并安装模型选择快照。
 * 与 dsh-host-apiproxy 的 composeAgent 同一套语义：先 resolve，再 mount。
 * @param {string | undefined} presetId - 跟随发起者会话的 preset（缺省时取部署默认）。
 * @param {{provider?: string, model?: string, reasoningEffort?: unknown} | undefined} selection - 模型选择；缺省取全局默认。
 * @returns {Promise<string | undefined>} 解析出的 preset id（无 roster 时为空）。
 */
async function installPreset(ctx, agentCtx, presetId, selection) {
  const presets = ctx.get('agentPresets');
  const chosen = selection ?? currentSelection(ctx);
  const installModel = () => {
    if (chosen === undefined) return;
    try {
      installModelSelection(agentCtx, { current: chosen, assembled: undefined });
    } catch {
      // 选择服务不可用时静默降级，确保 preset 挂载优先。
    }
  };
  if (presets && typeof presets.resolve === 'function' && typeof presets.mount === 'function') {
    const resolved = await presets.resolve(presetId);
    installModel();
    await presets.mount(agentCtx, resolved.id);
    return resolved.id;
  }
  installModel();
  return undefined;
}

/** 组装新会话的模型选择：以调用方的当前选择为基底，支持 model / reasoning_effort 显式覆盖。 */
async function buildSelection(ctx, args) {
  const base = currentSelection(ctx) ?? {};
  if (base.provider === undefined && args.model === undefined) {
    // 无基底也无指定：不覆盖（保持旧行为：不传 agentOptions）。
    return undefined;
  }
  const selection = {
    provider: base.provider,
    model: args.model ?? base.model,
  };
  if (args.reasoning_effort !== undefined) {
    selection.reasoningEffort = ReasoningEffortId(String(args.reasoning_effort));
  } else if (base.reasoningEffort !== undefined) {
    selection.reasoningEffort = base.reasoningEffort;
  }
  return selection;
}

/** 把新会话附着到工作区（侧边栏项目下可见）；找不到工作区则跳过。 */
async function attachWorkspace(ctx, cwd, sessionId) {
  const registry = ctx.get('workspaceRegistry');
  if (!registry) return;
  try {
    const workspace = typeof registry.resolveByPath === 'function'
      ? await registry.resolveByPath(cwd)
      : undefined;
    if (workspace && typeof workspace.attachSession === 'function') {
      await workspace.attachSession(sessionId);
    }
  } catch {
    // 依附失败不影响任务投递本身。
  }
}

/** 把一条 user 消息投递给目标 Agent 并唤醒它（对称通道的唯一原语）。 */
function deliver(ctx, targetAgent, text) {
  targetAgent.followup(createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }));
}

/**
 * 确保目标会话"在运行中"：活跃直接返回；未打开的从磁盘恢复成活跃 agent（叫醒），
 * 并为其挂载该会话记录的 preset。恢复失败返回 { error }，绝不抛出（调用方转成工具错误）。
 * @returns {Promise<{agent: import('@deepseek-ai/dsh-agent').Agent, resumed: boolean} | {error: string}>}
 */
async function ensureLiveAgent(ctx, agents, sessionId) {
  const live = agents.get(sessionId);
  if (live !== undefined) return { agent: live, resumed: false };

  const persistence = ctx.get('sessionPersistence');
  if (!persistence || typeof persistence.inspect !== 'function') {
    return { error: 'sessionPersistence 服务不可用：当前宿主组合缺少持久化服务，无法叫醒未打开的会话。' };
  }
  let inspected;
  try {
    inspected = await persistence.inspect(sessionId);
  } catch (error) {
    return { error: `会话 ${sessionId} 不存在或无法读取（${error instanceof Error ? error.message : String(error)}）。` };
  }
  const meta = inspected?.meta;
  if (!meta) {
    return { error: `会话 ${sessionId} 不存在或无法读取。` };
  }
  if (meta.parentSession !== undefined || (meta.delegationDepth ?? 0) > 0) {
    return { error: `会话 ${sessionId} 是子会话/代理会话，不可被独立恢复。` };
  }
  const storedPreset = resolveSessionPreset({ header: meta, events: inspected.events ?? [] });
  try {
    const selection = currentSelection(ctx);
    const { agent } = await agents.resume({
      resumeSessionId: SessionId(sessionId),
      agentOptions: selection === undefined ? undefined : {
        provider: selection.provider,
        model: selection.model,
      },
      setup: async (agentCtx) => {
        await installPreset(ctx, agentCtx, storedPreset);
      },
    });
    return { agent, resumed: true };
  } catch (error) {
    return { error: `恢复会话 ${sessionId} 失败：${error instanceof Error ? error.message : String(error)}` };
  }
}

/** 汇总一条会话事件的中文纯文本（仅 text 块）。 */
function textOfBlock(blocks) {
  return (blocks ?? [])
    .filter((block) => block && block.type === 'text')
    .map((block) => block.text)
    .join('');
}

/**
 * 注册全部 cross_session_* 工具。
 * @param {import('@deepseek-ai/cordis').Context} ctx - 插件上下文（apply 内显式 ctx.get 解析 tools/agents，缺失即抛错）。
 * @param {{ stateDir: string }} config - 已解析配置。
 */
export function apply(ctx, config) {
  const stateDir = config.stateDir ?? '.cross-session';

  // P2-6：不再用 inject 阻塞 profile 启动；改为在 apply() 显式解析服务，
  // 缺失时抛出清晰错误（同时覆盖原 P1-1 的 agents 完整性守卫，不重复告警）。
  const tools = ctx.get('tools');
  const agents = ctx.get('agents');
  if (!tools || typeof tools.register !== 'function') {
    throw new Error('[dsh-cross-session] 需要宿主提供 tools 服务（register）；请使用 dsh-base 类 profile（web/tui/headless）。');
  }
  if (!agents || typeof agents.create !== 'function' || typeof agents.resume !== 'function') {
    throw new Error('[dsh-cross-session] 需要宿主提供 agents 服务（create/resume）；请使用 dsh-base 类 profile。');
  }

  // ── cross_session_spawn ────────────────────────────────────────────────────
  tools.register(defineTool({
    name: 'cross_session_spawn',
    description: '创建一个全新的顶层会话（与侧边栏会话同等级，持久、可复用，未结束前一直在），并立刻把任务作为其第一条用户消息投递过去、唤醒它执行。本工具立即返回、绝不等待任务完成：你可以继续做其他工作。会话完成后（或失败时）会调用 cross_session_reply 把结果回复给你。返回的 session_id 用于后续 cross_session_send / cross_session_status / cross_session_read。可选 model / reasoning_effort 指定新会话的模型与推理程度（默认继承调用者选择）。',
    parameters: {
      name: { type: 'string', required: true, description: '新会话的名字（便于你在侧边栏和其他工具里识别，例如 "调研助手"）。' },
      task: { type: 'string', required: true, description: '要交给这个新会话执行的任务描述，务必完整、可验收。' },
      reply_to: { type: 'string', description: '可选：任务结果回复给哪个会话 id（默认 = 调用者本会话；可指定"帮别人派活"或"回给第三方"。' },
      model: { type: 'string', description: '可选：新会话使用的模型 id（默认继承调用者的当前模型；provider 沿用调用者）。' },
      reasoning_effort: { type: 'string', description: '可选：推理程度（off/low/medium/high/max 等，由适配器定义；默认继承调用者）。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          session_id: { type: 'string', required: true },
          name: { type: 'string', required: true },
          status: { type: 'string', required: true },
          model: { type: 'string', required: true },
          reasoning_effort: { type: 'string', required: true },
        },
      },
      render: (args, value) => [{
        type: 'text',
        text: `已创建会话「${value.name}」（${value.session_id}），模型 ${value.model ?? '(未选定)'} · 推理 ${value.reasoning_effort ?? '(默认)'}，任务已投递，对方已开始执行。你可以继续做别的工作；完成后它会通过 cross_session_reply 回复给你。`,
      }],
    },
    async execute(args, exec) {
      const caller = requireAgent(exec);
      const cwd = workspaceOf(caller);
      const sessionId = `session-${randomUUID()}`;
      const captain = args.reply_to ?? caller.id;
      const selection = await buildSelection(ctx, args);

      const { agent } = await agents.create({
        sessionId: SessionId(sessionId),
        meta: { cwd },
        agentOptions: selection === undefined ? undefined : {
          provider: selection.provider,
          model: selection.model,
        },
        setup: async (agentCtx) => {
          // 跟随发起者会话的 preset（与 UI 新开会话同语义）+ 生效的模型选择（含推理程度）。
          await installPreset(ctx, agentCtx, resolveSessionPreset(caller.session), selection);
        },
      });

      const taskMessage = `[cross-session] 你是由会话 ${caller.id} 创建的任务会话「${args.name}」。
任务：${args.task}

工作完成后（或无法完成时），你必须调用 cross_session_reply 工具，把最终结果/结论回复给指定会话：
  - captain_session_id = ${captain}
  - text 里给出完整的结果摘要（或失败原因）。
回复完成后本次任务即告结束；若创建者后续通过 cross_session_send 再次给你发消息，你将收到新的任务。`;
      deliver(ctx, agent, taskMessage);
      await attachWorkspace(ctx, cwd, sessionId);

      await safeRegistry(cwd, stateDir, (registry) => {
        registry.workers[sessionId] = {
          name: args.name,
          leadSessionId: captain,
          createdAt: Date.now(),
          lastTaskAt: Date.now(),
          task: args.task,
          model: selection?.model ?? null,
          reasoningEffort: selection?.reasoningEffort != null ? String(selection.reasoningEffort) : null,
          replies: [],
        };
      }, 'spawn');

      return {
        session_id: sessionId,
        name: args.name,
        status: 'task_sent',
        model: selection?.model ?? '',
        reasoning_effort: selection?.reasoningEffort != null ? String(selection.reasoningEffort) : '',
      };
    },
  }));

  // ── cross_session_send ─────────────────────────────────────────────────────
  tools.register(defineTool({
    name: 'cross_session_send',
    description: '给任意会话发送一条用户消息并唤醒它执行（与创建时发任务用的是同一条通道）。目标会话打开中直接投递；未打开的会自动从磁盘恢复（叫醒）后投递，并挂载该会话记录的 preset。可选 reply_to 指定"任务结果回给谁"，否则对方按自己的任务书回复。',
    parameters: {
      session_id: { type: 'string', required: true, description: '目标会话 id（cross_session_spawn 返回的 session_id，或任意存在的会话 id）。' },
      message: { type: 'string', required: true, description: '发送给该会话的消息/新任务。' },
      wake: { type: 'boolean', description: '是否立即唤醒目标会话执行（默认 true；false 则仅排队，等它当前工作完成后再处理）。' },
      reply_to: { type: 'string', description: '可选：本次任务的回复目标会话 id；提供后消息会附加上"完成后把结果回复给该会话"的指令。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          session_id: { type: 'string', required: true },
          status: { type: 'string', required: true },
          mode: { type: 'string', required: true },
        },
      },
      render: (args, value) => [{
        type: 'text',
        text: `消息已投递给会话 ${value.session_id}（${value.mode === 'resumed' ? '未打开，已从磁盘叫醒' : '原本就活跃'}；${args.wake === false ? '已排队，未唤醒' : '已唤醒'}）。`,
      }],
    },
    async execute(args, exec) {
      requireAgent(exec);
      const resolved = await ensureLiveAgent(ctx, agents, args.session_id);
      if (resolved.error) {
        throw new Error(resolved.error);
      }
      const { agent, resumed } = resolved;
      const directive = args.reply_to
        ? `\n\n（本次任务完成后，请调用 cross_session_reply，把结果回复给会话 ${args.reply_to}：captain_session_id = ${args.reply_to}。）`
        : '';
      deliver(ctx, agent, args.message + directive);
      const cwd = workspaceOf(agent);
      await safeRegistry(cwd, stateDir, (registry) => {
        const worker = registry.workers[args.session_id];
        if (worker) worker.lastTaskAt = Date.now();
      }, 'send');
      return {
        session_id: args.session_id,
        status: args.wake === false ? 'queued' : 'delivered',
        mode: resumed ? 'resumed' : 'live',
      };
    },
  }));

  // ── cross_session_reply ────────────────────────────────────────────────────
  tools.register(defineTool({
    name: 'cross_session_reply',
    description: '任务会话专用：把工作结果通过同一条通道（followup 用户消息）回复给创建你的会话，并立即唤醒它处理。目标会话打开中直接投递；未打开的会自动从磁盘恢复（叫醒）后投递，确保回信永远送得到。创建者的会话在它自己的对话里会看到这条回复。',
    parameters: {
      captain_session_id: { type: 'string', required: true, description: '要回复给的目标会话 id（创建你的会话 id，从任务消息里读取）。' },
      text: { type: 'string', required: true, description: '回复内容：完整的结果摘要、结论或失败原因。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          delivered: { type: 'boolean', required: true },
          woken: { type: 'boolean', required: true },
          mode: { type: 'string', required: true },
        },
      },
      render: (args, value) => [{
        type: 'text',
        text: `回复已投递给会话 ${args.captain_session_id} 并唤醒它（${value.mode === 'resumed' ? '目标未打开，已从磁盘叫醒' : '目标原本活跃'}）。`,
      }],
    },
    async execute(args, exec) {
      const caller = requireAgent(exec);
      const resolved = await ensureLiveAgent(ctx, agents, args.captain_session_id);
      if (resolved.error) {
        throw new Error(resolved.error);
      }
      const { agent, resumed } = resolved;
      const replyText = `[cross-session] 来自会话 ${caller.id} 的回复：
${args.text}`;
      deliver(ctx, agent, replyText);

      const cwd = workspaceOf(caller);
      await safeRegistry(cwd, stateDir, (registry) => {
        const worker = registry.workers[caller.id];
        if (worker) {
          worker.replies.push({ at: Date.now(), to: args.captain_session_id, text: args.text });
          worker.lastReplyAt = Date.now();
        }
      }, 'reply');
      return { delivered: true, woken: true, mode: resumed ? 'resumed' : 'live' };
    },
  }));

  // ── cross_session_status ───────────────────────────────────────────────────
  tools.register(defineTool({
    name: 'cross_session_status',
    description: '查看跨会话消息的登记状态：所有通过 cross_session_spawn 创建的任务会话、它们是否仍在运行、各自的回复情况。可选传入某个会话 id 只看它。',
    parameters: {
      session_id: { type: 'string', description: '可选：只查看这个会话 id。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          sessions: { type: 'array', items: { type: 'object', additionalProperties: true }, required: true },
        },
      },
      render: (args, value) => [{
        type: 'text',
        text: value.sessions.length === 0
          ? '没有登记的任务会话。'
          : value.sessions.map((s) => (
              `- ${s.name}（${s.session_id}）：${s.running ? '运行中' : '已停止'}，创建于 ${new Date(s.createdAt).toLocaleString()}，回复 ${s.replyCount} 次`
              + (s.leadSessionId ? `，回信对象：${s.leadSessionId}` : '')
              + (s.model ? `，模型 ${s.model}${s.reasoning_effort ? ` · 推理 ${s.reasoning_effort}` : ''}` : '')
              + (s.lastReplyText ? `，最近回复：${s.lastReplyText}` : '')
            )).join('\n'),
      }],
    },
    async execute(args, exec) {
      // 以调用者工作区为登记根（跨会话协作通常在同一项目内）。
      const cwd = workspaceOf(requireAgent(exec));
      let sessions = [];
      await safeRegistry(cwd, stateDir, (registry) => {
        for (const [id, worker] of Object.entries(registry.workers)) {
          if (args.session_id !== undefined && args.session_id !== id) continue;
          const running = agents.get(id) !== undefined;
          const last = worker.replies && worker.replies.length > 0
            ? worker.replies[worker.replies.length - 1]
            : undefined;
          sessions.push({
            session_id: id,
            name: worker.name,
            running,
            createdAt: worker.createdAt,
            replyCount: worker.replies ? worker.replies.length : 0,
            lastReplyText: last ? `${last.text.slice(0, 120)}${last.text.length > 120 ? '…' : ''}` : '',
            leadSessionId: worker.leadSessionId ?? '',
            model: worker.model ?? '',
            reasoning_effort: worker.reasoningEffort != null ? String(worker.reasoningEffort) : '',
          });
        }
      }, 'status');
      sessions.sort((a, b) => a.createdAt - b.createdAt);
      return { sessions };
    },
  }));

  // ── cross_session_read ─────────────────────────────────────────────────────
  tools.register(defineTool({
    name: 'cross_session_read',
    description: '读取某个会话最近的工作过程/结果（它的事件表层：用户消息与助手回复，不含工具调用细节）。目标会话打开中直接读内存；未打开的从磁盘日志读取（无需叫醒，任何会话随时可读）。',
    parameters: {
      session_id: { type: 'string', required: true, description: '要读取的会话 id。' },
      tail: { type: 'number', description: '读取最近几条消息（默认 10，最大 50）。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          session_id: { type: 'string', required: true },
          messages: { type: 'array', items: { type: 'object', additionalProperties: true }, required: true },
        },
      },
      render: (args, value) => [{
        type: 'text',
        text: value.messages.length === 0
          ? `会话 ${value.session_id} 还没有任何消息。`
          : value.messages.map((m) => `${m.role === 'assistant' ? '[助手]' : '[用户]'} ${m.text}`).join('\n'),
      }],
    },
    async execute(args) {
      const tail = typeof args.tail === 'number' ? Math.min(Math.max(1, Math.floor(args.tail)), 50) : 10;
      const messages = [];
      const collect = (events) => {
        for (const event of events ?? []) {
          if (event.type !== 'user/message' && event.type !== 'assistant/message') continue;
          const text = textOfBlock(event.data?.message?.content);
          if (text.trim() === '') continue;
          messages.push({
            role: event.type === 'assistant/message' ? 'assistant' : 'user',
            text,
          });
        }
      };

      // 1) 活跃会话 → 直接读内存事件。
      const target = agents.get(args.session_id);
      if (target !== undefined) {
        collect(target.session.events);
        return {
          session_id: args.session_id,
          messages: messages.slice(-tail),
        };
      }

      // 2) 未打开 → 从磁盘日志读取（sessionQuery 的只读折叠，无需叫醒）。
      const query = ctx.get('sessionQuery');
      if (!query || typeof query.readSession !== 'function') {
        throw new Error(`会话 ${args.session_id} 当前不在运行中，且 sessionQuery 服务不可用，无法从磁盘读取。`);
      }
      let events;
      try {
        ({ events } = await query.readSession(args.session_id));
      } catch (error) {
        throw new Error(`会话 ${args.session_id} 不存在或日志无法读取（${error instanceof Error ? error.message : String(error)}）。`);
      }
      collect(events);
      return {
        session_id: args.session_id,
        messages: messages.slice(-tail),
      };
    },
  }));

  // ── cross_session_list ─────────────────────────────────────────────────────
  tools.register(defineTool({
    name: 'cross_session_list',
    description: '快速列出当前项目（工作区）的所有顶层会话（默认不含已归档）：每个会话的名称、会话 id、模型名称与推理程度。数据来自 sessionQuery 服务（标题与模型从会话日志折叠，会话无需打开即可读取）。',
    parameters: {
      limit: { type: 'number', description: '最多列出多少个会话（默认 20；按创建时间最新优先）。' },
      include_archived: { type: 'boolean', description: '是否同时列出已归档会话（默认 false）。' },
      cwd: { type: 'string', description: '可选：指定工作区目录（默认取调用者会话的工作区）。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          sessions: { type: 'array', items: { type: 'object', additionalProperties: true }, required: true },
        },
      },
      render: (args, value) => [{
        type: 'text',
        text: value.sessions.length === 0
          ? '没有找到顶层会话。'
          : value.sessions.map((s) => {
              const model = s.model ?? '(未请求)';
              const effort = s.reasoning_effort ?? '?';
              return `- 「${s.title ?? '(无标题)'}」 ${model} · 推理 ${effort} · ${s.session_id}`
                + (s.archived ? ' · 已归档' : '');
            }).join('\n'),
      }],
    },
    async execute(args, exec) {
      const query = ctx.get('sessionQuery');
      if (!query || typeof query.listSessions !== 'function' || typeof query.readSession !== 'function') {
        throw new Error('sessionQuery 服务不可用：无法枚举顶层会话（当前宿主组合缺少该服务）。');
      }
      const cwd = normalizeCwd(args.cwd ?? workspaceOf(requireAgent(exec)));
      const limit = typeof args.limit === 'number' ? Math.min(Math.max(1, Math.floor(args.limit)), 100) : 20;
      const includeArchived = args.include_archived === true;

      // 已归档 id 集合（服务缺失时降级为不筛选）。
      let archived = new Set();
      try {
        const registry = ctx.get('workspaceRegistry');
        if (registry && Array.isArray(registry.archivedSessionIds)) {
          archived = new Set(registry.archivedSessionIds);
        }
      } catch {
        // 降级：不筛查归档状态。
      }

      // 顶层 = 无父会话；限定在工作区内（工作区注册表只在多工作区时有必要）。
      const records = await query.listSessions();
      const top = records
        .filter((r) => r.header.parentSession === undefined && normalizeCwd(r.header.cwd ?? '') === cwd)
        .filter((r) => includeArchived || !archived.has(r.header.id));

      const sessions = [];
      for (const record of top.slice(0, limit)) {
        const id = record.header.id;
        let title;
        let model;
        let effort;
        try {
          const rawTitle = await query.readTitle(id);
          // foldSessionTitle 返回对象 { title, messageSeqs, ... }，取字符串标题。
          title = rawTitle && typeof rawTitle === 'object' ? rawTitle.title : rawTitle;
        } catch {
          // 标题失败不影响主流程。
        }
        try {
          const { events } = await query.readSession(id);
          for (let i = events.length - 1; i >= 0; i--) {
            const e = events[i];
            if (!e || e.type !== 'request/header') continue;
            const config = e.data?.header?.config ?? e.data?.config;
            if (config) {
              model = config.model ?? null;
              effort = config.reasoningEffort ?? null;
              break;
            }
          }
        } catch {
          // 日志读取/校验失败：模型信息留空，标题照常展示。
        }
        sessions.push({
          session_id: id,
          title: textOrNull(title),
          model: textOrNull(model),
          reasoning_effort: textOrNull(effort),
          archived: archived.has(id),
          created_at: numberOrNull(record.header?.createdAt),
        });
      }
      return { sessions };
    },
  }));

  // ── cross_session_rename ─────────────────────────────────────────────────
  tools.register(defineTool({
    name: 'cross_session_rename',
    description: '修改任意会话的名称（标题）。目标会话当前打开时走官方 SessionTitleService.rename（自动规范化，追加 session/title 事件并钉住标题）；未打开时直接向持久化日志追加 session/title 事件（source: user），同样钉住。成功后该标题固定，不再被自动生成的标题覆盖。',
    parameters: {
      session_id: { type: 'string', required: true, description: '目标会话 id（形如 session-xxxx，可用 cross_session_list 查询）。' },
      name: { type: 'string', required: true, description: '新名称（标题），建议 1-60 个字符；会被规范化为单行。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          session_id: { type: 'string', required: true },
          title: { type: 'string', required: true },
          seq: { type: 'number', required: true },
          mode: { type: 'string', required: true },
        },
      },
      render: (args, value) => [{
        type: 'text',
        text: `已将会话 ${value.session_id} 改名为「${value.title}」（${value.mode === 'live' ? '活跃会话：官方 rename 通道' : '关闭会话：直接落盘'}，事件 seq ${value.seq}）。`,
      }],
    },
    async execute(args, exec) {
      const sessionId = args.session_id;
      const rawTitle = String(args.name ?? '').trim();
      if (rawTitle.length === 0) {
        throw new Error('会话名不能为空或纯空白。');
      }

      // 1) 目标会话在运行中 → 官方 rename（内部规范化 + 钉住 + 事件走完整写路径）。
      const target = agents.get(sessionId);
      if (target !== undefined) {
        const titles = ctx.get('sessionTitle');
        if (!titles || typeof titles.rename !== 'function') {
          throw new Error('sessionTitle 服务不可用：当前宿主组合未挂载标题服务，无法给活跃会话改名。');
        }
        const snap = titles.rename(target.session, rawTitle);
        return {
          session_id: sessionId,
          title: snap.title,
          seq: snap.eventSeq,
          mode: 'live',
        };
      }

      // 2) 目标会话未打开 → 直接向持久化日志追加 session/title 事件。
      const persistence = ctx.get('sessionPersistence');
      if (!persistence || typeof persistence.append !== 'function') {
        throw new Error('sessionPersistence 服务不可用：当前宿主组合未挂载持久化服务，无法给未打开的会话改名。');
      }
      const query = ctx.get('sessionQuery');
      if (!query || typeof query.readSession !== 'function') {
        throw new Error('sessionQuery 服务不可用：无法读取目标会话的日志。');
      }

      // 规范化（与官方策略对齐：单行、去控制符、限长）。
      const normalized = String(rawTitle)
        .replace(/[\u0000-\u001f\u007f]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      if (normalized.length === 0) {
        throw new Error('会话名规范化后为空，请使用可见字符。');
      }
      const title = Array.from(normalized).slice(0, 60).join('');

      let events;
      try {
        ({ events } = await query.readSession(sessionId));
      } catch (error) {
        throw new Error(`无法读取会话 ${sessionId} 的日志（${error instanceof Error ? error.message : String(error)}）；请确认会话存在。`);
      }
      const lastSeq = Array.isArray(events) && events.length > 0 && Number.isSafeInteger(events[events.length - 1]?.seq)
        ? events[events.length - 1].seq
        : -1;

      await persistence.append(sessionId, [{
        type: 'session/title',
        seq: lastSeq + 1,
        time: Date.now(),
        data: {
          title,
          messageSeqs: [],
          source: { kind: 'user' },
        },
      }]);

      return {
        session_id: sessionId,
        title,
        seq: lastSeq + 1,
        mode: 'closed',
      };
    },
  }));

  // ── cross_session_broadcast ────────────────────────────────────────────────
  tools.register(defineTool({
    name: 'cross_session_broadcast',
    description: '一次给多个会话发送不同的消息（每个会话可以有各自独特的任务/指令），安排它们分别执行。逐个投递并给出结果：目标打开中直接投递，未打开的自动从磁盘恢复（叫醒）后投递；失败的会话给出原因，不影响其他会话。',
    parameters: {
      targets: {
        type: 'array',
        required: true,
        description: '目标列表：每项 { session_id, message, wake? }；每个 message 可以完全不同，用于给各会话安排不同任务。',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            session_id: { type: 'string', required: true, description: '目标会话 id。' },
            message: { type: 'string', required: true, description: '发给该会话的独特消息/任务（各条可以不同）。' },
            wake: { type: 'boolean', description: '是否立即唤醒目标会话（默认 true；false 则仅排队）。' },
            reply_to: { type: 'string', description: '可选：本次任务的回复目标会话 id；提供后该会话会按要求把结果回给指定对象。' },
          },
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          results: {
            type: 'array',
            required: true,
            items: { type: 'object', additionalProperties: true },
          },
        },
      },
      render: (args, value) => [{
        type: 'text',
        text: value.results.length === 0
          ? '没有目标会话。'
          : value.results.map((r) => `- ${r.ok ? '✅' : '❌'} ${r.session_id}：${r.ok ? (r.resumed ? '未打开，已叫醒并投递' : '已投递（原本活跃）') + (r.wake === false ? '（排队未唤醒）' : '（已唤醒）') : (r.error ?? '失败')}`).join('\n'),
      }],
    },
    async execute(args, exec) {
      requireAgent(exec);
      const results = [];
      for (const target of args.targets ?? []) {
        const resolved = await ensureLiveAgent(ctx, agents, target.session_id);
        if (resolved.error) {
          results.push({ session_id: target.session_id, ok: false, error: resolved.error });
          continue;
        }
        const directive = target.reply_to
          ? `\n\n（本次任务完成后，请调用 cross_session_reply，把结果回复给会话 ${target.reply_to}：captain_session_id = ${target.reply_to}。）`
          : '';
        deliver(ctx, resolved.agent, target.message + directive);
        const cwd = workspaceOf(resolved.agent);
        await safeRegistry(cwd, stateDir, (registry) => {
          const worker = registry.workers[target.session_id];
          if (worker) worker.lastTaskAt = Date.now();
        }, 'broadcast');
        results.push({
          session_id: target.session_id,
          ok: true,
          resumed: resolved.resumed,
          wake: target.wake !== false,
        });
      }
      return { results };
    },
  }));

  // ── cross_session_archive ──────────────────────────────────────────────────
  tools.register(defineTool({
    name: 'cross_session_archive',
    description: '把任意会话归档（与 GUI 右键"归档"同一条官方通道：workspaceRegistry.archiveSession，持久化、幂等）。归档后会话从侧边栏分组隐藏，但内容与工作区账目保留，随时可恢复。',
    parameters: {
      session_id: { type: 'string', required: true, description: '要归档的会话 id（live 或已持久化均可）。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          session_id: { type: 'string', required: true },
          archived_count: { type: 'number', required: true },
        },
      },
      render: (args, value) => [{
        type: 'text',
        text: `已归档会话 ${value.session_id}（当前共 ${value.archived_count} 个已归档会话）。`,
      }],
    },
    async execute(args, exec) {
      requireAgent(exec);
      const registry = ctx.get('workspaceRegistry');
      if (!registry || typeof registry.archiveSession !== 'function') {
        throw new Error('workspaceRegistry 服务不可用：当前宿主组合未挂载工作区注册服务，无法归档。');
      }
      await registry.archiveSession(args.session_id);
      const archived = Array.isArray(registry.archivedSessionIds) ? registry.archivedSessionIds : [];
      return {
        session_id: args.session_id,
        archived_count: archived.length,
      };
    },
  }));
}
