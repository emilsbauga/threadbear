// docs/machines.md is drawn from the backend's state machines' own rules
// (convex/machines.ts), as the website's Machines page draws them: this fails
// when it's out of date, or when a state, transition or timer has no
// description. `npm run machine-docs` in runner/ writes it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { load } from '../helpers/convex-memory.ts';

const ROOT = path.join(import.meta.dirname, '..', '..', '..');
const FILE = path.join(ROOT, 'docs', 'machines.md');
const library = await import(pathToFileURL(createRequire(path.join(ROOT, 'package.json')).resolve('@convex-dev/state-machines')).href);

function machineDocs(): string {
  const manifests = load('machines').machines.manifests as { name: string; description?: string }[];
  const parts = [
    '# The backend\'s state machines',
    '',
    'Drawn from the rules the backend runs (`convex/machines.ts`), as the website\'s Machines page draws them, by `npm run machine-docs` in runner/: don\'t edit it by hand. docs/lifecycles.md says which lifecycles are machines so far, and which are next.',
    '',
  ];
  for (const m of manifests) {
    parts.push(`## ${m.name}`, '', m.description ?? '', '', '```mermaid', library.stateDiagram(m).trimEnd(), '```', '', library.explainTransitions(m).trimEnd(), '');
  }
  return parts.join('\n');
}

test('every state, transition and timer of every machine says what it means', () => {
  assert.deepEqual(library.missingDescriptions(load('machines').machines.manifests), []);
});

test('docs/machines.md matches the machines', () => {
  const made = machineDocs();
  if (process.env.UPDATE_MACHINE_DOCS === '1') {
    fs.writeFileSync(FILE, made);
    return;
  }
  // Windows' git can check it out with CRLF line endings.
  const written = fs.existsSync(FILE) ? fs.readFileSync(FILE, 'utf8').replace(/\r\n/g, '\n') : '';
  assert.equal(written, made, 'docs/machines.md is out of date: run `npm run machine-docs` in runner/ and commit it');
});
