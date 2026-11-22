// A Plan first plan's card on the website, read as the iPhone's PlanCard reads it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planBody, planDecisionLabel, planTitle } from './plan.ts';

const plan = '# Bots and webhook triggers\n\n1. Add a bots table\n2. Call the webhook on each new message';

test("the title is the plan's first heading, without its marks", () => {
  assert.equal(planTitle(plan), 'Bots and webhook triggers');
  assert.equal(planTitle('Intro line\n\n## The **real** `plan`\n\n- a'), 'The real plan');
});

test('a plan with no heading takes its first line, and an empty one is "Plan"', () => {
  assert.equal(planTitle('Do the thing first\n\n- then this'), 'Do the thing first');
  assert.equal(planTitle('  \n\n'), 'Plan');
  assert.equal(planTitle('#'), 'Plan');
});

test('the body is the plan without its title line, wherever that was', () => {
  assert.equal(planBody(plan), '1. Add a bots table\n2. Call the webhook on each new message');
  // The website has no sheet with the whole plan, so the title isn't drawn twice or lost (review, 22 Nov).
  assert.equal(planBody('Do the thing first\n\n- then this'), '- then this');
  assert.equal(planBody('Context first\n\n## Steps\n\n1. a'), 'Context first\n\n1. a');
});

test('a long title is kept whole, as nothing else on the website shows it', () => {
  const long = 'x'.repeat(150);
  assert.equal(planTitle(`# ${long}`), long);
});

test('a decided plan says so, as the Mac card does', () => {
  assert.equal(planDecisionLabel('go'), 'Approved');
  assert.equal(planDecisionLabel('revise'), 'Sent back');
  assert.equal(planDecisionLabel(undefined), undefined);
});
