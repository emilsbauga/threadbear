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
  const { tools } = await call('/tools');
  const names = new Set(tools.map(tool => tool.name));
  for (const tool of tools) pi.registerTool({ ...tool, async execute(id, input, signal) {
    const result = await call('/tool', { name: tool.name.replace(/^mcp__threadbear__/, ''), input, id }, signal);
    const text = (result.contentItems ?? []).map(item => item.text ?? '').join('\n');
    if (!result.success) throw new Error(text || 'Threadbear tool failed.');
    return { content: [{ type: 'text', text }], details: {} };
  } });
  pi.on('tool_call', async (event, ctx) => {
    if (names.has(event.toolName)) return; // The host gates these before executing their handlers.
    try {
      const decision = await call('/approve', { name: event.toolName, input: event.input, id: event.toolCallId }, ctx.signal);
      if (!decision.allow) return { block: true, reason: decision.reason ?? 'Approval denied.' };
    } catch { return { block: true, reason: 'Threadbear approval was cancelled or unavailable.' }; }
  });
}
