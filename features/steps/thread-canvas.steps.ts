// The Canvas page (thread-canvas.feature, the threadCanvas experiment): what
// the scripted app's `canvas` command says about the board
// (desktop/gpui/src/thread_canvas.rs, `canvas_state`).
import { Then, When } from '@cucumber/cucumber';
import { okValue, sleep } from '../support/driver.ts';
import type { ThreadbearWorld } from '../support/world.ts';

type Spot = { id: string; area: string; col: number; row: number; ghost: boolean };
type Board = { showing: boolean; entered: string | null; entering: string | null; flying: boolean; threads?: Spot[]; edges?: number; strip?: string[] };

async function board(world: ThreadbearWorld, cmd: Record<string, unknown> = {}): Promise<Board> {
  return JSON.parse(okValue(await world.app.do({ cmd: 'canvas', ...cmd }, 30))) as Board;
}

async function untilBoard(world: ThreadbearWorld, what: string, check: (b: Board) => boolean): Promise<void> {
  const deadline = Date.now() + 15_000;
  let last: Board | string = 'no answer yet';
  for (;;) {
    try {
      last = await board(world);
      if (check(last)) return;
    } catch (e) {
      last = (e as Error).message;
    }
    if (Date.now() > deadline) throw new Error(`Never saw: ${what}\n\nThe board said: ${JSON.stringify(last)}`);
    await sleep(150);
  }
}

const spot = (b: Board, id: string) => b.threads?.find((t) => t.id === id);

When('I open the Canvas page', async function (this: ThreadbearWorld) {
  // The experiment comes in hello, which the app may still be reading.
  const deadline = Date.now() + 15_000;
  for (;;) {
    try {
      await board(this, { show: true });
      break;
    } catch (e) {
      if (Date.now() > deadline) throw e;
      await sleep(200);
    }
  }
  await untilBoard(this, 'the board up with threads on it', (b) => b.showing && (b.threads?.length ?? 0) > 0);
});

Then('the board has the thread {string}', async function (this: ThreadbearWorld, id: string) {
  await untilBoard(this, `${id} on the board`, (b) => !!spot(b, id) && !spot(b, id)?.ghost);
});

Then('the board has the thread {string} beside {string}', async function (this: ThreadbearWorld, id: string, parent: string) {
  await untilBoard(this, `${id} to the right of ${parent}, in its area`, (b) => {
    const c = spot(b, id);
    const p = spot(b, parent);
    return !!c && !!p && c.area === p.area && c.col > p.col && c.row >= p.row;
  });
});

Then('the board has arrows', async function (this: ThreadbearWorld) {
  await untilBoard(this, 'arrows', (b) => (b.edges ?? 0) > 0);
});

Then('the board has no thread {string}', async function (this: ThreadbearWorld, id: string) {
  await untilBoard(this, `no ${id}`, (b) => !spot(b, id));
});

Then('the board has a ghost of {string}', async function (this: ThreadbearWorld, id: string) {
  await untilBoard(this, `a ghost of ${id}`, (b) => spot(b, id)?.ghost === true);
});

When('I click the thread {string} on the board', async function (this: ThreadbearWorld, id: string) {
  await board(this, { enter: id });
});

Then('the board is inside the thread {string}', async function (this: ThreadbearWorld, id: string) {
  await untilBoard(this, `inside ${id}`, (b) => b.entered === id && !b.flying);
});

When('I leave the thread on the board', async function (this: ThreadbearWorld) {
  await board(this, { leave: true });
});

Then('the board is out of any thread', async function (this: ThreadbearWorld) {
  await untilBoard(this, 'out of the thread', (b) => b.showing && !b.entered && !b.entering && !b.flying);
});

When('I archive the thread {string}', async function (this: ThreadbearWorld, id: string) {
  // Opening it takes the page down, as any thread opened elsewhere does.
  await this.app.do({ cmd: 'open', id });
  await this.app.do({ cmd: 'waitFor', loaded: true }, 30);
  await this.app.do({ cmd: 'archive' });
  await board(this, { show: true });
});

When('I tidy the board', async function (this: ThreadbearWorld) {
  await board(this, { tidy: true });
});

When('I go to the Threads view', async function (this: ThreadbearWorld) {
  await this.app.do({ cmd: 'mode', mode: 'inbox' });
});

Then('the Canvas page is down', async function (this: ThreadbearWorld) {
  await untilBoard(this, 'the page down', (b) => !b.showing);
});
