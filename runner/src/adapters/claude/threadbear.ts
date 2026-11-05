import { createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import type { McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import { buildThreadbearTools, serverInstructions, SERVER_NAME, ALWAYS_ASK_TOOLS, type ThreadControl, type ScheduleControl, type ProjectControl, type AppRestartControl, type PocketControl } from '../../threadbear-mcp.ts';
import { RUNNER_VERSION } from '../../config.ts';
import type { ConnectorService } from '../../connectors.ts';
export function threadbearMcpServer(control: ThreadControl, selfId: string, schedules?: ScheduleControl, projects?: ProjectControl, appRestarts?: AppRestartControl, bulletReplies: () => boolean = () => true, pocket?: () => PocketControl | undefined, oneReply: () => boolean = () => false, gateway?: () => string | undefined, gatewayHealth?: () => Promise<ConnectorService[] | undefined>): McpSdkServerConfigWithInstance {
  const one = oneReply();
  const server = createSdkMcpServer({
    name: SERVER_NAME,
    version: RUNNER_VERSION,
    instructions: serverInstructions(selfId, { one, bulletReplies: bulletReplies(), pocket: Boolean(pocket?.()), projects: Boolean(projects) }),
    tools: buildThreadbearTools(control, selfId, Date.now, schedules, projects, appRestarts, { bulletReplies, pocket, oneReply: () => one, gateway, gatewayHealth }),
  });
  server.tools = [...ALWAYS_ASK_TOOLS].map((name) => ({ name: name.split('__').at(-1)!, permission_policy: 'always_ask' as const }));
  return server;
}

