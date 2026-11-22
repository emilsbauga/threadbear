// A Plan first plan (API 72), drawn as a card as the iPhone's PlanCard and
// the Mac's plan card draw it: a port of ThreadbearKit's Plans.title and
// Plans.body. Tests: node --test web/src/plan.test.ts

// The line the title comes from: the plan's first heading, else its first
// line. Unlike the iPhone's, which opens the whole plan in a sheet, the
// card here is all there is, so the title isn't cut short and its line
// leaves the body wherever it was.
function titleLine(lines: string[]): number {
  const heading = lines.findIndex((l) => l.trim().startsWith('#'));
  return heading >= 0 ? heading : lines.findIndex((l) => l.trim());
}

// The plan's title, without Markdown marks.
export function planTitle(text: string): string {
  const lines = text.split('\n');
  const at = titleLine(lines);
  const bare = at >= 0 ? lines[at]!.trim().replace(/^#+/, '').trim().replaceAll('**', '').replaceAll('`', '') : '';
  return bare || 'Plan';
}

// The plan without its title line, for the steps under it.
export function planBody(text: string): string {
  const lines = text.split('\n');
  const at = titleLine(lines);
  // The title line, and the blank line after it when there's one before it too.
  if (at >= 0) lines.splice(at, at > 0 && !lines[at - 1]!.trim() && !lines[at + 1]?.trim() ? 2 : 1);
  return lines.join('\n').trim();
}

// What a decided plan's card says, from its row's planDecision (API 76).
export function planDecisionLabel(decision: 'go' | 'revise' | undefined): string | undefined {
  return decision === 'go' ? 'Approved' : decision === 'revise' ? 'Sent back' : undefined;
}
