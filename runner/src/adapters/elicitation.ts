// A form an agent asks Mike to fill in (an MCP or ACP "elicitation": a JSON
// schema of flat fields), shown as Threadbear's question cards, and the
// card's answers turned back into the form's content. Codex's MCP servers
// use the field helpers (codex/approvals.ts); ACP agents use the whole of it
// (acp/adapter.ts), which is how OpenCode 2's question tool reaches Mike.
//
// The card has two limits this works around: only the last question takes a
// typed answer ("Something else"), and a multiple choice comes back as its
// labels joined with ", " (rows/cards.rs, question_answers).
import type { Question } from '../protocol.ts';

type Option = { const?: unknown; title?: string; description?: string };

export type FormProperty = {
  type?: string;
  title?: string;
  description?: string;
  enum?: unknown[];
  enumNames?: string[];
  oneOf?: Option[];
  items?: { enum?: unknown[]; oneOf?: Option[]; anyOf?: Option[] };
  default?: unknown;
};

export type FormSchema = { properties?: Record<string, FormProperty>; required?: string[] };

export type Choice = { label: string; value: unknown; description?: string };

// The choices a field offers: its own for a single answer, its items' for a
// list, Yes and No for a boolean, none for a typed answer.
export function choicesFor(prop: FormProperty): Choice[] {
  const fromOptions = (opts: Option[]) =>
    opts.map((o) => {
      const c: Choice = { label: o.title || String(o.const), value: o.const };
      if (o.description) c.description = o.description;
      return c;
    });
  if (prop.type === 'array') {
    const items = prop.items ?? {};
    const opts = items.anyOf?.length ? items.anyOf : items.oneOf;
    if (opts?.length) return fromOptions(opts);
    if (items.enum?.length) return items.enum.map((v) => ({ label: String(v), value: v }));
    return [];
  }
  if (Array.isArray(prop.oneOf) && prop.oneOf.length) return fromOptions(prop.oneOf);
  if (Array.isArray(prop.enum) && prop.enum.length) return prop.enum.map((v, i) => ({ label: prop.enumNames?.[i] || String(v), value: v }));
  if (prop.type === 'boolean') return [{ label: 'Yes', value: true }, { label: 'No', value: false }];
  return [];
}

// One answer as the field's type: a choice's value, a number, a boolean, or
// the words as typed.
export function elicitedValue(answer: string, prop: FormProperty, choices: Choice[]): unknown {
  const choice = choices.find((c) => c.label === answer);
  if (choice) return choice.value;
  if (prop.type === 'number' || prop.type === 'integer') {
    const n = Number(answer);
    return Number.isFinite(n) ? (prop.type === 'integer' ? Math.trunc(n) : n) : answer;
  }
  if (prop.type === 'boolean') return /^(y|yes|true|1)$/i.test(answer.trim());
  return answer;
}

type Field = {
  key: string;
  prop: FormProperty;
  choices: Choice[];
  multi: boolean;
  required: boolean;
  // `<key>_custom`: where words typed instead of a choice go (OpenCode's "other").
  custom?: string;
  question: string;
};

export type FormCards = { questions: Question[]; fields: Field[] };

// The cards for a form, or why it can't be shown. A form with no fields is
// left to the caller (an Accept or Decline of its message).
export function formQuestions(message: string, schema: FormSchema | undefined, source: string): FormCards | { unshown: string } | undefined {
  const props = schema?.properties ?? {};
  const required = new Set(Array.isArray(schema?.required) ? schema.required : []);
  const keys = Object.keys(props);
  const isCompanion = (k: string) => k.endsWith('_custom') && keys.includes(k.slice(0, -'_custom'.length)) && choicesFor(props[k.slice(0, -'_custom'.length)]).length > 0;
  let fields: Field[] = keys
    .filter((k) => !isCompanion(k))
    .map((key) => {
      const prop = props[key] ?? {};
      const f: Field = { key, prop, choices: choicesFor(prop), multi: prop.type === 'array', required: required.has(key), question: '' };
      if (keys.includes(`${key}_custom`) && f.choices.length) f.custom = `${key}_custom`;
      return f;
    });
  if (!fields.length) return undefined;
  // Words can only be typed into the last card: a field that takes nothing
  // else goes there, and two of them can't be shown at all.
  const typed = fields.filter((f) => !f.choices.length);
  if (typed.length > 1) return { unshown: `${source} asked for ${typed.length} typed answers at once, and Threadbear's card takes one.` };
  if (typed.length === 1) fields = [...fields.filter((f) => f !== typed[0]), typed[0]];
  const used = new Set<string>();
  // A bare "Questions" (OpenCode's own title for its question tool) says
  // nothing the cards don't.
  const intro = /^\s*questions?\s*$/i.test(message) ? '' : message.trim();
  const questions = fields.map((f, i) => {
    // The field's description is the question when it has one (OpenCode
    // puts the question there and a short header in the title).
    const label = f.prop.title || f.key;
    const detail = f.prop.description || label;
    let text = i === 0 && intro && intro !== detail ? `${intro}\n\n${detail}` : detail;
    // Answers come back keyed by the question's words, so no two can match.
    for (let n = 2; used.has(text); n++) text = `${detail} (${n})`;
    used.add(text);
    f.question = text;
    const q: Question = {
      question: text,
      header: label.slice(0, 30),
      multiSelect: f.multi,
      options: f.choices.map((c) => (c.description ? { label: c.label, description: c.description } : { label: c.label })),
    };
    return q;
  });
  return { questions, fields };
}

// The form's content from the card's answers, or undefined when a field it
// needs has no usable answer (the caller declines the form).
export function formContent(form: FormCards, answers: Record<string, string>): Record<string, unknown> | undefined {
  const content: Record<string, unknown> = {};
  for (const f of form.fields) {
    const raw = answers[f.question];
    const answer = typeof raw === 'string' ? raw.trim() : '';
    if (!answer) {
      if (f.required) return undefined;
      continue;
    }
    if (f.multi) {
      const { picked, rest } = splitChoices(answer, f.choices);
      if (picked.length) content[f.key] = picked.map((c) => c.value);
      if (rest && f.custom) content[f.custom] = rest;
      if (!picked.length && !(rest && f.custom) && f.required) return undefined;
      continue;
    }
    const choice = f.choices.find((c) => c.label === answer);
    if (choice) content[f.key] = choice.value;
    else if (!f.choices.length || f.prop.type === 'boolean') content[f.key] = elicitedValue(answer, f.prop, f.choices);
    else if (f.custom) content[f.custom] = answer;
    // Words where only the choices will do.
    else if (f.required) return undefined;
  }
  return content;
}

// "A, B, my own" back into the choices it names and any words left over.
// Joined labels can't simply be split on ", ", as a label can hold one, so
// the longest run of pieces that makes a label is taken at each step.
function splitChoices(answer: string, choices: Choice[]): { picked: Choice[]; rest: string } {
  const pieces = answer.split(', ');
  const picked: Choice[] = [];
  const rest: string[] = [];
  for (let i = 0; i < pieces.length; ) {
    let took = 0;
    for (let j = pieces.length; j > i; j--) {
      const c = choices.find((x) => x.label === pieces.slice(i, j).join(', '));
      if (c) {
        if (!picked.includes(c)) picked.push(c);
        took = j - i;
        break;
      }
    }
    if (took) i += took;
    else rest.push(pieces[i++]);
  }
  return { picked, rest: rest.join(', ') };
}
