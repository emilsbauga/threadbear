// What each provider is called and what it can do. The runner's checks read
// this rather than comparing provider names, and hello hands it to the apps
// (docs/protocol/types.md, `ProviderInfo`), so adding a provider is a row here and
// not a hunt through every `=== 'codex'`.
//
// What's left comparing names is really about one CLI's own files or
// behaviour (copying Claude's transcripts, Codex's model list).
import fs from 'node:fs';
import path from 'node:path';
import { parsePiProfiles } from './pi-profiles.ts';
import { PROVIDERS, type Provider, type ProviderInfo } from './protocol.ts';

export const PROVIDER_INFO: Record<Provider, ProviderInfo> = {
  claude: {
    id: 'claude',
    name: 'Claude',
    cliName: 'Claude Code',
    loginCommand: 'claude auth login',
    effort: 'claude',
    autoMode: 'classifier',
    rewind: true,
    smallJobs: true,
    usageReadings: true,
  },
  pi: { id: 'pi', name: 'Pi', cliName: 'Pi', loginCommand: 'pi', effort: 'none', autoMode: 'asks', rewind: false, smallJobs: false, usageReadings: false },
  codex: {
    id: 'codex',
    name: 'Codex',
    cliName: 'Codex',
    loginCommand: 'codex login',
    effort: 'codex',
    autoMode: 'asks',
    rewind: true,
    smallJobs: false,
    usageReadings: true,
  },
  // Over ACP (adapters/acp/): Auto behaves like Ask, and rewind doesn't
  // exist for them; only Grok says how much room a login has.
  cursor: {
    id: 'cursor',
    name: 'Cursor',
    cliName: 'Cursor Agent',
    loginCommand: 'agent login',
    effort: 'none',
    autoMode: 'asks',
    rewind: false,
    // Its read tools work in any mode and nothing turns them off, and a small
    // job's text can come from anywhere.
    smallJobs: false,
    usageReadings: false,
  },
  opencode: {
    id: 'opencode',
    name: 'OpenCode',
    cliName: 'OpenCode',
    loginCommand: 'opencode auth login',
    effort: 'none',
    autoMode: 'asks',
    rewind: false,
    smallJobs: true,
    usageReadings: false,
  },
  grok: {
    id: 'grok',
    name: 'Grok',
    cliName: 'Grok',
    loginCommand: 'grok login',
    // Its models list their own levels (low to xhigh), which narrow this
    // (AcpSession sets them as the session's thought_level option).
    effort: 'codex',
    autoMode: 'asks',
    rewind: false,
    // Threadbear's hook denies every tool for a small job, reads included
    // (adapters/acp/grok-guard.ts).
    smallJobs: true,
    // Its plan's weekly share, from _x.ai/billing (adapters/acp/grok-billing.ts).
    usageReadings: true,
  },
  // Gemini on a Google plan, through Google's antigravity-acp. It has no
  // sign-in command of its own (it signs in over ACP's authenticate).
  antigravity: {
    id: 'antigravity',
    name: 'Gemini',
    cliName: 'Antigravity',
    loginCommand: '',
    effort: 'none',
    autoMode: 'asks',
    rewind: false,
    smallJobs: false,
    usageReadings: false,
  },
};

// Pi is offered only with configured profiles; installed ACP agents are standard.
export function activeProviders(home: string): Provider[] {
  let pi = false;
  try { pi = parsePiProfiles(JSON.parse(fs.readFileSync(path.join(home, 'runner.json'), 'utf8')).pi, home).length > 0; } catch { /* Invalid config is handled at startup. */ }
  return PROVIDERS.filter((p) => p !== 'pi' || pi);
}

// One this build has no row for (a record or another runner's hello from a
// build that has more): it can do nothing, so no check takes it for Claude
// and lets it into something only Claude can do.
function unknownProvider(id: string): ProviderInfo {
  return { id, name: id, cliName: id, loginCommand: '', effort: 'none', autoMode: 'asks', rewind: false, smallJobs: false, usageReadings: false };
}

// No provider at all is a Claude one, as a record from before Codex is
// (store.ts). hasOwn, as the id can come from another runner and
// "constructor" is no row.
export function providerInfo(provider: string | undefined): ProviderInfo {
  const id = provider || 'claude';
  return Object.hasOwn(PROVIDER_INFO, id) ? PROVIDER_INFO[id as Provider] : unknownProvider(id);
}

// A provider's name in notes.
export function providerName(provider: string | undefined): string {
  return providerInfo(provider).name;
}

// The program's name, for notes about its versions.
export function cliName(provider: string | undefined): string {
  return providerInfo(provider).cliName;
}

export function providersForHello(providers: readonly Provider[] = PROVIDERS): ProviderInfo[] {
  return providers.map((p) => PROVIDER_INFO[p]);
}
