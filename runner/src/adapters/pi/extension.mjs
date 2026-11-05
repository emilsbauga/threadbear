const END_TURN = 'mcp__threadbear__end_turn';
export const COMPACT_END_DESCRIPTION = 'Call this once to finish every turn, as your last tool call. Follow the reply ordering in your Threadbear instructions. Set needs to you for user action, otherwise nothing. Use asks for decisions and next for useful follow-ups. Archive or snooze only when requested.';
export const COMPACT_GUIDANCE = 'Use tool_search to find other Threadbear app tools only when needed (threads, projects, schedules, panels, secrets). Search specifically with limit 1 or 2. Use native tools for file and shell work.';

export function compactToolContext(model, mode = 'auto') {
  if (mode !== 'auto') return mode === 'compact';
  const size = model?.contextWindow;
  if (Number.isFinite(size) && size > 0 && size < 70000) return true;
  try {
    const host = new URL(model?.baseUrl).hostname.toLowerCase();
    return host === 'localhost' || host.endsWith('.localhost') || host === '[::1]' || /^127(?:\.\d{1,3}){3}$/.test(host);
  } catch { return false; }
}

export function withoutDescriptions(value) {
  if (Array.isArray(value)) return value.map(withoutDescriptions);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'description').map(([key, child]) => [key,
    ['properties', '$defs', 'definitions', 'patternProperties'].includes(key) && child && typeof child === 'object'
      ? Object.fromEntries(Object.entries(child).map(([name, schema]) => [name, withoutDescriptions(schema)]))
      : withoutDescriptions(child),
  ]));
}

// Explicitly loaded by Threadbear; never discovered from a project.
export default async function (pi) {
  const url = process.env.THREADBEAR_PI_BRIDGE_URL;
  const token = process.env.THREADBEAR_PI_BRIDGE_TOKEN;
  if (!url || !token) throw new Error('Threadbear Pi bridge is not configured.');
  const call = async (route, input, signal) => {
    const response = await fetch(url + route, { method: input ? 'POST' : 'GET', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, ...(input ? { body: JSON.stringify(input) } : {}), signal });
    if (!response.ok) throw new Error('Threadbear tool bridge rejected the request.');
    return response.json();
  };
  const { tools, toolContext = 'auto' } = await call('/tools');
  const names = new Set(tools.map(tool => tool.name));
  let searchInitiallyActive;
  const executable = tools.map(tool => ({ ...tool, async execute(id, input, signal) {
    const result = await call('/tool', { name: tool.name.replace(/^mcp__threadbear__/, ''), input, id }, signal);
    const text = (result.contentItems ?? []).map(item => item.text ?? '').join('\n');
    if (!result.success) throw new Error(text || 'Threadbear tool failed.');
    return { content: [{ type: 'text', text }], details: {} };
  } }));
  let registeredMode;
  const select = model => {
    searchInitiallyActive ??= pi.getActiveTools().includes('tool_search');
    // An older Pi without native deferred search retains its full tool set.
    const compact = compactToolContext(model, toolContext) && pi.getAllTools().some(tool => tool.name === 'tool_search');
    if (compact !== registeredMode) {
      for (const tool of executable) pi.registerTool({ ...tool, defaultActive: false,
        exposure: compact && tool.name !== END_TURN ? 'deferred' : 'direct',
        ...(compact && tool.name === END_TURN ? { description: COMPACT_END_DESCRIPTION, parameters: withoutDescriptions(tool.parameters), promptGuidelines: [COMPACT_GUIDANCE] } : {}),
      });
      registeredMode = compact;
    }
    const native = pi.getActiveTools().filter(name => !names.has(name) && (name !== 'tool_search' || searchInitiallyActive));
    pi.setActiveTools([...native, ...(compact ? ['tool_search', ...tools.filter(tool => tool.name === END_TURN).map(tool => tool.name)] : names)]);
  };
  pi.on('session_start', (_event, ctx) => select(ctx.model));
  pi.on('before_agent_start', (_event, ctx) => select(ctx.model));
  pi.on('tool_call', async (event, ctx) => {
    if (names.has(event.toolName)) return; // The host gates these before executing their handlers.
    try {
      const decision = await call('/approve', { name: event.toolName, input: event.input, id: event.toolCallId }, ctx.signal);
      if (!decision.allow) return { block: true, reason: decision.reason ?? 'Approval denied.' };
    } catch { return { block: true, reason: 'Threadbear approval was cancelled or unavailable.' }; }
  });
}
