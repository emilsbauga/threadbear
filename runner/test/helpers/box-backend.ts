// A backend (convex-memory.ts) with one virtual runner and one thread's box
// on it (convex/boxes.ts, docs/virtual-runners.md), for the box tests:
// boxes-backend.test.ts and box-access.test.ts. Actions run with a ctx that
// has no database, their runQuery and runMutation calling the real
// functions, as Convex runs them.
import { call, load, memoryBackend } from './convex-memory.ts';

export const OWNER = 'owner-key';
export const SEAL_KEY = Buffer.alloc(32, 7).toString('base64');
export const CLAUDE_TOKEN = `sk-ant-oat01-${'Q'.repeat(60)}`;
export const LOGIN = 'me@example.com';
export const BOX_RUNNER = 'box0thread01';
export const THREAD = 'box-thread-1';
export const ORIGIN_WITH_TOKEN = 'https://mike:ghp_SECRETSECRET@github.com/mikecann/threadbear.git';

// The box tests' clock starts at midday (UTC) today. A box's awake time is
// counted by the UTC day (convex/boxMachine.ts awakeAdded), and a test that
// moves the clock on a few minutes with later() saw the count go back to
// nothing when that crossed midnight: GitHub's Windows run at 23:54 UTC on
// 18 Nov failed two of box-service's charging tests that pass any other time.
{
  const realNow = Date.now;
  const midday = new Date(realNow()).setUTCHours(12, 0, 0, 0);
  const offset = midday - realNow();
  Date.now = () => realNow() + offset;
}

const boxes = load('boxes');
const machinesModule = load('machines');

type Backend = ReturnType<typeof memoryBackend>;

/** What an action's ctx has: no db, and runQuery/runMutation that run the functions they name. */
export function actionCtx(b: Backend) {
  const fn = (ref: unknown) => {
    const [, mod, name] = String(ref).split('.');
    const f = load(mod!)[name!];
    if (!f) throw new Error(`box-backend: no function ${String(ref)}`);
    return f;
  };
  return {
    runQuery: (ref: unknown, args: Record<string, unknown>) => call(b.ctx, fn(ref), args),
    runMutation: (ref: unknown, args: Record<string, unknown>) => call(b.ctx, fn(ref), args),
    storage: b.ctx.storage,
    scheduler: b.ctx.scheduler,
  };
}

export async function later<T>(ms: number, f: () => Promise<T>): Promise<T> {
  const realNow = Date.now;
  Date.now = () => realNow() + ms;
  try {
    return await f();
  } finally {
    Date.now = realNow;
  }
}

// opts.token false: the login has no cloud token, so the helper's box waits in needsToken.
export async function boxBackend(opts: { token?: boolean } = {}) {
  process.env.RUNNER_KEY = OWNER;
  delete process.env.RUNNER_KEY_NEXT;
  process.env.BOX_SEAL_KEY = SEAL_KEY;
  process.env.CONVEX_SITE_URL = 'https://site.example';
  const b = memoryBackend();
  const a = actionCtx(b);
  const serviceId = await b.ctx.db.insert('runnerServices', { name: 'Cloud (Fly)', provider: 'fly', box: { cpus: 2, memoryMb: 4096 }, image: 'registry.fly.io/threadbear-box:1', limits: { ...boxes.BOX_LIMITS }, createdAt: Date.now() });
  const newBox = (threadId = THREAD, runnerId = BOX_RUNNER) => call(a, boxes.newBox, { serviceId, threadId, runnerId, login: LOGIN, repo: { origin: ORIGIN_WITH_TOKEN, subfolder: 'runner', baseBranch: 'main' } });
  const setToken = (token = CLAUDE_TOKEN, login = LOGIN, key = OWNER) => call(a, boxes.setCloudToken, { key, login, token });
  // A login with a cloud token, as a box's thread needs to start (boxMachine.ts needsToken).
  if (opts.token !== false) await setToken();
  const boxId = await newBox();
  const mint = async (threadId = THREAD, key = OWNER): Promise<string> => (await call(a, boxes.mintBootToken, { key, threadId })).bootToken;
  const exchange = (bootToken: string) => call(a, boxes.exchange, { bootToken });
  const report = (event: Record<string, unknown>, threadId = THREAD): Promise<boolean> => call(b.ctx, boxes.report, { threadId, event });
  const box = (threadId = THREAD) => b.rows('boxes').find((r) => r.threadId === threadId)!;
  const state = (threadId = THREAD): string => box(threadId).boxState.kind;
  // A box booted to awake: its exchange's answer.
  const boot = async (threadId = THREAD) => {
    if (!b.rows('cloudTokens').length) await setToken();
    return exchange(await mint(threadId));
  };
  // Fires the machine's timers due by `at`, as Convex's scheduler would.
  const fireTimers = async (at: number) => {
    for (const t of b.pendingTimers().filter((t) => t.at <= at)) {
      await later(at - Date.now(), () => call(b.ctx, machinesModule.deliver, t.args));
      b.timerRan(t.id);
    }
  };
  return { ...b, a, serviceId, boxId, newBox, setToken, mint, exchange, report, box, state, boot, fireTimers };
}
