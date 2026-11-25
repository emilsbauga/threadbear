// Gemini's plan usage, read from antigravity-acp's own /usage answer
// (src/adapters/acp/agy-usage.ts). Mike's Gemini login showed in Usage with
// no figures (23 Nov 2026): its turns carry none, and the server's /usage
// is the only way in that doesn't read the login's token.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agyPlan, agyResetTime, parseAgyUsage } from '../../src/adapters/acp/agy-usage.ts';

// antigravity-acp 1.4.5's answer on Mike's Google AI Ultra plan, 23 Nov 2026.
const SAMPLE = `### Session Usage
- **Session total:** data not available yet

### Quota Limits
- **Gemini Models**
  *(Models within this group: Gemini 4 Neon, Gemini 4 Carbon, Gemini 4 Argon, Gemini 4 Hydrogen, Gemini 3.8 Flash)*
  - **Weekly Limit Remaining:** 55% remaining (resets Nov 28, 2026, 08:49 UTC)
  - **Five Hour Limit Remaining:** 91% remaining (resets Nov 23, 2026, 09:35 UTC)
- **Claude and GPT models**
  *(Models within this group: Claude Opus 5.5, Claude Sonnet 5.5, GPT-OSS 120B)*
  - **Weekly Limit Remaining:** 100% remaining (resets Nov 30, 2026, 05:08 UTC)
  - **Five Hour Limit Remaining:** 100% remaining (resets Nov 23, 2026, 10:08 UTC)
`;

test("the Gemini group's windows are the login's 5-hour and weekly, the others extra windows that never decide its room", () => {
  assert.deepEqual(parseAgyUsage(SAMPLE), {
    windows: [
      { kind: 'weekly', title: 'Weekly', remainingPercent: 55, resetsAt: '2026-11-28T08:49:00.000Z' },
      { kind: 'five_hour', title: '5-hour', remainingPercent: 91, resetsAt: '2026-11-23T09:35:00.000Z' },
      { kind: 'weekly_model', title: 'Weekly Claude and GPT', remainingPercent: 100, resetsAt: '2026-11-30T05:08:00.000Z' },
      { kind: 'other', title: '5-hour Claude and GPT', remainingPercent: 100, resetsAt: '2026-11-23T10:08:00.000Z' },
    ],
    blocked: false,
    // Shown, but never deciding its room or its block (Runner.recordReading, UsageStore.record).
    aside: ['Weekly Claude and GPT', '5-hour Claude and GPT'],
  });
});

test('a Gemini window at its limit says blocked; the other group at its limit does not', () => {
  const geminiOut = SAMPLE.replace('91% remaining', '0% remaining');
  assert.equal(parseAgyUsage(geminiOut)?.blocked, true);
  const otherOut = SAMPLE.replace('100% remaining (resets Nov 30', '0% remaining (resets Nov 30');
  assert.equal(parseAgyUsage(otherOut)?.blocked, false);
});

test('anything that does not read is no reading, not an error', () => {
  assert.equal(parseAgyUsage(''), undefined);
  assert.equal(parseAgyUsage('Usage is not available right now.'), undefined);
  assert.equal(parseAgyUsage(undefined as unknown as string), undefined);
  // No Gemini group, or two: which decides the room isn't clear.
  assert.equal(parseAgyUsage(SAMPLE.replace('**Gemini Models**', '**Fast Models**')), undefined);
  assert.equal(parseAgyUsage(SAMPLE.replace('**Claude and GPT models**', '**Gemini Pro models**')), undefined);
  // A Gemini group with no windows that read.
  assert.equal(parseAgyUsage('- **Gemini Models**\n  - **Weekly Limit Remaining:** lots remaining\n'), undefined);
});

test('the format drifting a little still reads; a reset it cannot place is left out, not guessed', () => {
  const drifted = `## Quota
* **Gemini models**
    * **Weekly limit:** 45.5% used (resets Dec 1, 2026, 8:05 UTC)
    * **5-hour limit remaining:** 12% left (resets tomorrow)
`;
  assert.deepEqual(parseAgyUsage(drifted)?.windows, [
    { kind: 'weekly', title: 'Weekly', remainingPercent: 54.5, resetsAt: '2026-12-01T08:05:00.000Z' },
    { kind: 'five_hour', title: '5-hour', remainingPercent: 12 },
  ]);
  // A percentage past 100 is nonsense: that window is dropped.
  assert.deepEqual(parseAgyUsage(SAMPLE.replace('55% remaining', '155% remaining'))?.windows.map((w) => w.kind), ['five_hour', 'weekly_model', 'other']);
  // Lines under Session Usage belong to no group.
  assert.equal(parseAgyUsage('### Session Usage\n- **Weekly Limit Remaining:** 5% remaining\n'), undefined);
});

test('reset times: only ones that say UTC, and only real dates', () => {
  assert.equal(agyResetTime('Nov 28, 2026, 08:49 UTC'), '2026-11-28T08:49:00.000Z');
  assert.equal(agyResetTime('November 3, 2026, 23:00:30 GMT'), '2026-11-03T23:00:30.000Z');
  assert.equal(agyResetTime('Nov 28, 2026, 08:49'), undefined);
  assert.equal(agyResetTime('Nov 28, 2026, 08:49 PST'), undefined);
  assert.equal(agyResetTime('Nov 31, 2026, 08:49 UTC'), undefined);
  assert.equal(agyResetTime('Foo 3, 2026, 08:49 UTC'), undefined);
});

test("the plan's name comes from session/new's _meta", () => {
  assert.equal(agyPlan({ _meta: { antigravity: { tier: { name: 'Google AI Ultra', id: 'g1-ultra-lite-tier' } } } }), 'Google AI Ultra');
  assert.equal(agyPlan({ _meta: {} }), undefined);
  assert.equal(agyPlan(null), undefined);
  assert.equal(agyPlan({ _meta: { antigravity: { tier: { name: 7 } } } }), undefined);
});

// From Gemini's review of this change (23 Nov 2026).

test("with one Gemini window unread, a reading with room doesn't say unblocked; one at its limit still says blocked", () => {
  const oneUnread = SAMPLE.replace('91% remaining', 'Exhausted');
  assert.equal(parseAgyUsage(oneUnread)?.blocked, undefined);
  assert.equal(parseAgyUsage(oneUnread.replace('55% remaining', '0% remaining'))?.blocked, true);
});

test("a group header with a colon still starts its group, so its windows never land in Gemini's", () => {
  const text = `- **Gemini Models**
  - **Weekly Limit Remaining:** 55% remaining (resets Nov 28, 2026, 08:49 UTC)
- **Claude and GPT models:**
  - **Five Hour Limit Remaining:** 100% remaining (resets Nov 23, 2026, 10:08 UTC)
`;
  assert.deepEqual(parseAgyUsage(text)?.windows.map((w) => [w.kind, w.title]), [['weekly', 'Weekly'], ['other', '5-hour Claude and GPT']]);
  // A top-level bullet that isn't a header ends the group before it.
  const unknown = text.replace('- **Claude and GPT models:**', '- Claude and GPT models (preview)');
  assert.deepEqual(parseAgyUsage(unknown)?.windows.map((w) => w.kind), ['weekly']);
});

test('an indented bold line with a colon is a line inside its group, not a new group', () => {
  const text = SAMPLE.replace('  - **Five Hour Limit Remaining:** 91%', '  - **Note:**\n  - **Five Hour Limit Remaining:** 91%');
  assert.deepEqual(parseAgyUsage(text)?.windows.slice(0, 2).map((w) => w.kind), ['weekly', 'five_hour']);
});
