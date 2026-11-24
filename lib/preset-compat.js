// Local compatibility shim.
//
// Upstream `dsh-cross-session` 0.3.3 imports `resolveSessionPreset` from
// `@deepseek-ai/dsh-agent-presets`. That package was folded into
// `@deepseek-ai/dsh-agent-preset-registry` in DSH 0.1.2-alpha.2 and the export
// is gone, which breaks the plugin on every DSH release since.
//
// The original implementation is small and dependency-free: the effective
// preset is the newest `agent-preset/selected` event, falling back to the
// creation-time value on the session header. DSH 0.2.2 still uses both that
// event type and the `agentPreset` header field, so this port is behaviour
// preserving.
//
// @param session - `{ header, events }` for the session to resolve.
// @returns the preset id, or `undefined` when none was recorded.
export function resolveSessionPreset(session) {
  const events = Array.isArray(session?.events) ? session.events : [];
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type === 'agent-preset/selected') return event.data?.agentPreset;
  }
  return session?.header?.agentPreset;
}

export default resolveSessionPreset;
