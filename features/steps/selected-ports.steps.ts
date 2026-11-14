import assert from 'node:assert/strict';
import { When, Then } from '@cucumber/cucumber';
import type { ThreadbearWorld } from '../support/world.ts';
import { okValue } from '../support/driver.ts';

When('the runner advertises the configured Pi login', async function (this: ThreadbearWorld) {
  const accounts = JSON.parse(okValue(await this.app.do({ cmd: 'mock', method: 'accounts', params: {} }))).accounts;
  accounts.push({ id: 'pi:local', provider: 'pi', title: 'Local Pi', configDir: '/mock/pi-local', piProfileId: 'local', executable: '/mock/bin/pi', defaultModel: 'local-model', connection: { provider: 'lmstudio', model: 'local-model' }, models: [{ id: 'local-model', model: 'local-model', title: 'Local model' }] });
  await this.app.do({ cmd: 'mock', method: 'accounts', params: { accounts } });
});

Then('Pi offers no Claude model aliases or unadvertised effort choices', async function (this: ThreadbearWorld) {
  const result = JSON.parse(okValue(await this.app.do({ cmd: 'composer-menu', menu: 'model' }))) as string[];
  const next = result.findIndex((line, i) => i > 0 && line.startsWith('#'));
  const own = result.slice(0, next < 0 ? result.length : next);
  assert.ok(!/Opus|Sonnet|Haiku|Fable/.test(own.join('\n')), own.join('\n'));
  const effort = result.indexOf('# Effort');
  const choices = result.slice(effort + 1).filter(line => !line.startsWith('---')).join('\n');
  assert.ok(!/\[.\] (Low|Medium|High|Max|Ultra)/.test(choices), choices);
});

Then('Pi sign-in opens the interactive profile and explains {string}', async function (this: ThreadbearWorld, guidance: string) {
  const script = okValue(await this.app.do({ cmd: 'signin', account: 'pi:local', script: true }));
  assert.ok(script.includes(guidance), script);
  assert.ok(script.includes("PI_CODING_AGENT_DIR='/mock/pi-local' '/mock/bin/pi'"), script);
  assert.ok(script.includes('--no-tools --no-extensions --no-mcp --no-skills --no-context-files'), script);
});

Then('the Pi model chip includes {string}', async function (this: ThreadbearWorld, model: string) {
  await this.until('the Pi model chip', d => d.composer.chip?.includes(model));
});

Then('Evolving titles is off', async function (this: ThreadbearWorld) {
  await this.until('Evolving titles switched off', d => (d as unknown as {settingsWindow?: {evolvingTitles?: boolean}}).settingsWindow?.evolvingTitles === false);
});

When('the current folder offers the ranked test skills', async function (this: ThreadbearWorld) {
  const d = await this.app.dump();
  const skills = [
    { name: 'review-in-description', title: 'Other task', description: 'Review work', path: '/mock/skills/other/SKILL.md', scope: 'user' },
    { name: 'audit', title: 'Review', description: 'Check changes', path: '/mock/skills/audit/SKILL.md', scope: 'user' },
    { name: 'ship', title: 'Publish', description: 'Release changes', path: '/mock/skills/ship/SKILL.md', scope: 'repo' },
  ];
  await this.app.do({ cmd: 'mock', method: 'skills', params: { cwd: d.composer.cwd, skills } });
  await this.app.do({ cmd: 'mock', method: 'skills', params: { cwd: '/mock/empty-project', skills: [] } });
});

Then('the palette no longer offers {string}', async function (this: ThreadbearWorld, name: string) {
  await this.until('fresh skills for the selected folder', d => !!d.palette && !d.palette.note?.startsWith('Getting') && !d.palette.commands.includes(name));
});

Then('Pi does not offer Plan first', async function (this: ThreadbearWorld) {
  const menu = await this.app.do({ cmd: 'composer-menu', menu: 'permission' });
  assert.ok(!menu.includes('Plan first'), menu);
});
