import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formContent, formQuestions, type FormCards, type FormSchema } from '../../src/adapters/elicitation.ts';

// OpenCode 2.3.0's question tool, as its ACP side sends it (elicitation.ts):
// q<N> with the header as title and the question as description, options as
// oneOf (or an array's items.anyOf), and a q<N>_custom for typed words.
const OPENCODE: FormSchema = {
  properties: {
    q0: { type: 'string', title: 'Colour', description: 'Which colour should the button be?', oneOf: [{ const: 'Blue (Recommended)', title: 'Blue (Recommended)', description: 'Matches the logo' }, { const: 'Green', title: 'Green' }] },
    q0_custom: { type: 'string', title: 'Colour (other)', description: 'Type your own answer' },
    q1: { type: 'array', title: 'Where', description: 'Where should it go?', items: { anyOf: [{ const: 'Toolbar', title: 'Toolbar' }, { const: 'Menu, top', title: 'Menu, top' }] } },
    q1_custom: { type: 'string', title: 'Where (other)', description: 'Add your own answer' },
  },
  required: [],
};

const cards = (message: string, schema: FormSchema) => formQuestions(message, schema, 'OpenCode') as FormCards;

test("OpenCode's questions become one card each, the question as the words and the header as the chip", () => {
  const f = cards('Questions', OPENCODE);
  assert.deepEqual(f.questions, [
    { question: 'Which colour should the button be?', header: 'Colour', multiSelect: false, options: [{ label: 'Blue (Recommended)', description: 'Matches the logo' }, { label: 'Green' }] },
    { question: 'Where should it go?', header: 'Where', multiSelect: true, options: [{ label: 'Toolbar' }, { label: 'Menu, top' }] },
  ]);
});

test('choices go back as their values, a list as a list, even with a label holding ", "', () => {
  const f = cards('Questions', OPENCODE);
  assert.deepEqual(formContent(f, { 'Which colour should the button be?': 'Green', 'Where should it go?': 'Toolbar, Menu, top' }), { q0: 'Green', q1: ['Toolbar', 'Menu, top'] });
});

test('typed words go to the field for them: in place of one choice, beside a list', () => {
  const f = cards('Questions', OPENCODE);
  assert.deepEqual(formContent(f, { 'Which colour should the button be?': 'Orange', 'Where should it go?': 'Toolbar, the status bar' }), { q0_custom: 'Orange', q1: ['Toolbar'], q1_custom: 'the status bar' });
});

test('an unanswered optional question is left out; a required one declines the form', () => {
  const f = cards('Questions', OPENCODE);
  assert.deepEqual(formContent(f, { 'Which colour should the button be?': 'Blue (Recommended)' }), { q0: 'Blue (Recommended)' });
  const req = cards('Questions', { ...OPENCODE, required: ['q1'] });
  assert.equal(formContent(req, { 'Which colour should the button be?': 'Green' }), undefined);
});

test('words where only the choices will do: dropped if optional, a decline if required', () => {
  const schema: FormSchema = { properties: { size: { type: 'string', title: 'Size', enum: ['S', 'M'] } } };
  assert.deepEqual(formContent(cards('', schema), { Size: 'XL' }), {});
  assert.equal(formContent(cards('', { ...schema, required: ['size'] }), { Size: 'XL' }), undefined);
});

test('a typed-only field goes last, as only the last card takes words; two of them are not shown', () => {
  const schema: FormSchema = { properties: { name: { type: 'string', title: 'Name' }, ok: { type: 'boolean', title: 'Ready?' } }, required: ['name'] };
  const f = cards('Set up the project', schema);
  assert.deepEqual(f.questions.map((q) => q.question), ['Set up the project\n\nReady?', 'Name']);
  assert.deepEqual(formContent(f, { 'Set up the project\n\nReady?': 'Yes', Name: 'demo' }), { ok: true, name: 'demo' });
  const two = formQuestions('', { properties: { a: { type: 'string' }, b: { type: 'number' } } }, 'OpenCode');
  assert.ok(two && 'unshown' in two);
});

test('numbers come back as numbers, and two questions with the same words stay apart', () => {
  const schema: FormSchema = { properties: { n: { type: 'integer', title: 'How many?' }, a: { type: 'string', title: 'Pick', enum: ['x'] }, b: { type: 'string', title: 'Pick', enum: ['y'] } } };
  const f = cards('', schema);
  assert.deepEqual(f.questions.map((q) => q.question), ['Pick', 'Pick (2)', 'How many?']);
  assert.deepEqual(formContent(f, { 'How many?': '3.7', Pick: 'x', 'Pick (2)': 'y' }), { n: 3, a: 'x', b: 'y' });
});

test('a form with no fields is left to the caller', () => {
  assert.equal(formQuestions('Continue?', { properties: {} }, 'OpenCode'), undefined);
});
