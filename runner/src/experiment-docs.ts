// docs/experiments.md, made from the experiment files (experiments.ts):
// what each does, for the guide (the website's Experiments page shows the
// list), and where each lives and how to take it out, for forks. Written
// by `npm run experiment-docs`; experiment-docs.test.ts fails when the
// file is out of date.
//
// Every entry is one line, and .gitattributes merges the file line by line
// (scripts/merge-lines.mjs): two threads that each add an experiment both
// keep their line when they land, where a hand-kept list made them collide
// (7 Nov), and one taking an experiment out doesn't get it back from the
// other (union did that, 17 Nov). The check compares the lines in any
// order, so a merge that lands them out of order still passes; the next
// `npm run experiment-docs` sorts them.
import type { Experiment } from './experiments.ts';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "2026-11-06" to "6 Nov 2026". */
export function longDate(day: string): string {
  const [y, m, d] = day.split('-').map(Number);
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

const oneLine = (text: string) => text.split(/\s+/).join(' ').trim();
const cell = (text: string) => oneLine(text).replaceAll('|', '\\|');

export const LIST_START = '<!-- list:start -->';
export const LIST_END = '<!-- list:end -->';

/** The guide's line for an experiment. */
export function guideLine(x: Experiment): string {
  return `- **${x.name}** (\`${x.id}\`, since ${longDate(x.added)}${x.on ? ', on unless you turn it off' : ''}). ${oneLine(x.does)}`;
}

export function experimentDocs(experiments: readonly Experiment[]): string {
  return [
    '# Experiments',
    '',
    '<!-- Made by `npm run experiment-docs` in runner/ from runner/src/experiments/*.md:',
    'edit those, not this. Each entry is one line, so two threads adding one at once',
    'both keep theirs (.gitattributes merges this file line by line). -->',
    '',
    'New features that are still being tried out start off, with a switch under',
    '`experiments` in `runner.json` (the user guide, "Experiments", says how to turn one',
    'on). These are the ones there are now.',
    '',
    '## What each one does',
    '',
    LIST_START,
    ...experiments.map(guideLine),
    LIST_END,
    '',
    '## Where each one lives, and taking it out',
    '',
    'For forks (docs/forking.md). Each one\'s switch is `experiments.<id>` in `runner.json`, and',
    'its own file is `runner/src/experiments/<id>.md`, which goes with it.',
    '',
    '| Experiment | Lives in | Taking it out |',
    '|---|---|---|',
    ...experiments.map((x) => `| ${cell(x.name)} (\`${x.id}\`) | ${cell(x.livesIn)} | ${cell(x.takingOut)} |`),
    '',
    '## Adding one, and ending one',
    '',
    'For agents adding a feature (AGENTS.md, "Experiments"). A new feature the owner of the copy is',
    'still trying out lands off by default and on for them. Bug fixes and polish go straight in: an',
    'experiment is for new behaviour that changes what threads do, what they cost, or what the',
    'runner does to the machine.',
    '',
    '- Give it a file of its own, `runner/src/experiments/<id>.md` (copy one that\'s there): its',
    '  id, name, title, `added` date, `on: false` and `reminder`, then what it does (for the',
    '  guide), where it lives and how to take it out (for forks). Check',
    '  `experimentOn(home, \'<id>\')` where it starts. Put `"experiments": { "<id>": true }` in the',
    '  owner\'s `runner.json` (`~/Library/Application Support/Threadbear/runner.json`) so it\'s on',
    '  for them. Settings > General > Experiments lists it by itself, with its name and "What it',
    '  does" behind the ⓘ (`settings.update`\'s `experiments`), so write those for the people',
    '  flipping it.',
    '- Run `npm run experiment-docs` in `runner/` and commit this file with it;',
    '  `experiment-docs.test.ts` fails while it\'s out of date. Edit the experiment\'s file, never',
    '  this one. One file each and a line-by-line merge here (`scripts/merge-lines.mjs`) mean two',
    '  threads adding or taking out experiments at once don\'t collide.',
    '- Book the check-in when it lands: `schedule_message` with `new_thread` in this repo, about',
    '  four days out, telling that thread to look at how the experiment has gone and ask the owner',
    '  whether to turn it on for everyone, keep trying it, or take it out. Its id is the file\'s',
    '  `reminder`; `experiments.test.ts` fails without one.',
    '- To make it standard, take the flag out entirely: its file, the `experimentOn` check, its',
    '  key in every runner.json that has it (each machine with a runner), then',
    '  `npm run experiment-docs`. Its "What it does" text moves to where the feature belongs in the',
    '  guide. Don\'t leave a default-on switch behind: every flag left in is another path through',
    '  the code to keep working. If people might really want it off, make it a normal setting',
    '  instead. To take it out, delete the feature with its flag.',
    '',
  ].join('\n');
}

/** The file's lines in a fixed order, to compare whatever order a merge left them in. */
export function sortedLines(text: string): string[] {
  return text.replace(/\r\n/g, '\n').split('\n').sort();
}
