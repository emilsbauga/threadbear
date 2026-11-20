# Box spike: does a paused box come back as the same runner?

Step 1 of [docs/virtual-runners.md](../../../docs/virtual-runners.md), first
bullet only, on Fly Machines and Daytona. Throwaway: nothing here is used
by the runner or the app.

A tiny stand-in "box agent" (`agent/agent.ts`, one bundled file) runs in a
box, holds a Convex websocket, heartbeats every 10 s with its pid and start
time, and takes commands queued for it. The driver then:

1. creates a box, and creates it again with the same idempotency key
   (a Convex action retry): there must be one box;
2. times create to first heartbeat, and runs one command while awake;
3. pauses the box and times it;
4. queues a command while it's paused and checks it stays `pending`, and
   that no heartbeat arrives, for `--pause-min` minutes;
5. resumes, times resume to first heartbeat, and compares pid and start
   time with before the pause: the same process, or a new one;
6. checks the paused command was taken and finished exactly once, that
   heartbeats keep coming, and whether the websocket reconnected;
7. destroys the box and checks it's gone from a list by tag.

It prints a JSON summary on stdout (progress on stderr) and exits 1 if a
check failed.

| Provider | What "pause" is | Expect |
|---|---|---|
| Fly | `suspend` (memory snapshot), `start` resumes | same process, unless Fly lost the snapshot and cold-booted |
| Daytona, `DAYTONA_CLASS=vm` (default) | `pause` on a Linux VM sandbox (`daytona-vm-small`) | same process |
| Daytona, `DAYTONA_CLASS=container` | `stop`/`start`, then the agent is launched again | new process (containers can't pause) |

## Files

- `convex/`: the spike's own backend (`boxes`, `commands`, `beats`); every
  function checks the `SPIKE_KEY` shared secret.
- `agent/agent.ts`: the box agent; `node build.ts` bundles it to
  `dist/agent.mjs` (the driver does this itself).
- `providers/`: the plan's `BoxProvider` interface and the Fly and Daytona
  adapters. Each file's header lists the endpoints used and what's unsure.
- `test/`: the adapters against a fake HTTP server (`node --test test/*.test.ts`; two small files).
- `driver.ts`: the run above, and `cleanup`.

## Running it

Environment:

| Variable | For |
|---|---|
| `CONVEX_URL` | the spike deployment's URL (in `.env.local` after `convex dev`) |
| `SPIKE_KEY` | any long random string; the same value set on the deployment |
| `FLY_API_TOKEN` | Fly (an org deploy token is enough) |
| `FLY_ORG` | Fly org slug, default `personal` |
| `FLY_APP`, `FLY_REGION` | optional: an app to use (else `tb-box-spike-*` is found or made) and a region |
| `DAYTONA_API_KEY` | Daytona |
| `DAYTONA_CLASS` | `vm` (default) or `container` |
| `DAYTONA_SNAPSHOT`, `DAYTONA_TARGET` | optional: another snapshot, a region |

```sh
cd runner/box/spike
taskpolicy -b npm install
taskpolicy -b node --test test/*.test.ts && taskpolicy -b npm run typecheck

# A throwaway deployment of the spike backend (first time: makes the project).
npx convex dev --once --configure new --team <team> --project tb-box-spike --dev-deployment cloud
export SPIKE_KEY=$(openssl rand -hex 24)
npx convex env set SPIKE_KEY "$SPIKE_KEY"
export CONVEX_URL=$(grep '^CONVEX_URL=' .env.local | cut -d= -f2)

FLY_API_TOKEN=... node driver.ts fly run --pause-min 10
DAYTONA_API_KEY=... node driver.ts daytona run --pause-min 10
DAYTONA_API_KEY=... DAYTONA_CLASS=container node driver.ts daytona run --pause-min 10

# Anything left behind (the driver destroys its box even on failure):
node driver.ts fly cleanup        # also deletes the tb-box-spike-* app
node driver.ts daytona cleanup
```

Daytona sandboxes also get `ttlMinutes: 120` as a backstop.

## Cost notes

From the price pages on 16 Nov 2026; fill in real numbers from the run.

- **Fly** ([pricing](https://docs.fly.io/about/pricing)): shared-cpu-1x with
  1 GB is $6.70 a month running (about $0.0093 an hour) in the cheapest
  regions (`iad`, `ewr`), more elsewhere ($7.73 in `fra`). Suspended or
  stopped, only the rootfs is billed, $0.15 per GB-month. A suspended
  Machine still holds its place on the host.
- **Daytona** ([pricing](https://www.daytona.io/pricing)): per second,
  $0.0504 per vCPU-hour, $0.0162 per GiB-hour, $0.000108 per GiB-hour of
  disk after 5 free, so 1 vCPU + 1 GiB is about $0.067 an hour awake. The
  page doesn't say what a paused or stopped sandbox costs, or price VM
  sandboxes separately; the [persistence docs](https://www.daytona.io/docs/en/persistence)
  only say they're "retained until you delete them".

## Results

Run on 16 Nov 2026 from the M5 against a throwaway Convex dev deployment
(`tb-box-spike` in the mikec team). Every check passed on both providers:
the retried create found the first box, a command queued while the box was
paused stayed `pending` and was taken exactly once after the wake, nothing
heartbeated while paused, and the box was gone after destroy.

| | Fly Machines (suspend) | Daytona (container, stop/start) |
|---|---|---|
| Create call | 6.7 s | 16.3 s |
| Create to first heartbeat | 8.6 s (12.4 s on a second run) | 16.3 s |
| Pause | 1.3 s | 3.0 s |
| Resume call | 0.9 s | 4.9 s |
| Resume to first heartbeat | 59.5 s, then **3.3 s** with the fix below | 5.0 s |
| Same process after the wake | yes, memory kept (10 min pause) | no, the agent is started again |

- **The 60-second reconnect.** On Fly the process came back at once, but its
  websocket was dead and the Convex client only found out when the socket
  timed out. `agent.ts` now watches for a jump in the wall clock between
  two ticks and makes a new client straight away, which took the wake to
  3.3 s (3-minute pause). The real runner will need the same, and it would
  help the laptop's runner after the Mac sleeps.
- **Daytona's memory-keeping VM sandboxes aren't offered on this account**:
  creating from `daytona-vm-small` says "not available in region us", and
  the same for `eu`. So Daytona is a disk-kept provider for now
  (`DAYTONA_CLASS=container`).
- **Cost** at these sizes (price pages, not measured): Fly shared-cpu-1x
  1 GB about $0.0093/h awake, and a suspended machine pays only for its
  root disk ($0.15/GB-month). Daytona 1 vCPU / 1 GiB about $0.067/h awake.
- Not yet tested: losing a box (restore from a save), Claude Code through
  the login proxy, cold start of a real runner with a clone of threadbear.

## The login test (17 Nov 2026)

`claude-turn.ts`, with `convex/login.ts` and `box/turn.mjs`: one real
Claude turn in a Fly box on a `claude setup-token` token kept in Convex
(docs/virtual-runners.md, decision 10).

- The driver stores the token with `login:setLogin`, which seals it with
  AES-GCM under the deployment's `SEAL_KEY`, and mints a boot token
  (`login:mintBoot`: single use, 10 minutes, kept hashed).
- The box gets only `CONVEX_URL` and `BOOT_TOKEN`. It trades the boot token
  (`login:exchange`) for the Claude token and a report key, installs Claude
  Code and runs `claude -p` on Haiku with `CLAUDE_CODE_OAUTH_TOKEN` set
  only on that child process.

```sh
CLAUDE_TOKEN_FILE=~/.config/threadbear-box-spike/claude-token node claude-turn.ts
```

Every check passed: the token wasn't in the Fly machine's config or the
box's environment, the boot token worked once and was refused after, and
Haiku answered "box ok" (US$0.0014). Create to report took 40 s, of which
22 s was `npm install` of Claude Code, which a real image would have
baked in; the turn itself took 1.8 s.

`claude setup-token` makes a token with `scope=user:inference` (model use
only), valid a year. When it can open a real browser, claude.ai hands the
code back to a localhost callback by itself, so Threadbear can make the
token for the user with one click and an Authorize, no pasting.

## Losing a box (18 Nov 2026)

`lose-box.ts`, with `convex/lose.ts` and `box/lose.mjs`: a thread outlives
its box (docs/virtual-runners.md, decisions 3 and 7).

1. Box A trades its boot token for a box key scoped to the thread (which
   replaces any earlier box's key in the same mutation), the Claude token,
   the thread's own key and the thread's session id. It runs a Haiku turn
   with `--session-id` that writes `notes.txt` (left uncommitted) and is
   told a number to remember but not write down.
2. The driver asks for a save. Box A tars the folder and
   `~/.claude/projects`, seals it with AES-256-GCM under the thread key and
   puts it in Convex file storage. The driver pauses box A, then destroys
   it.
3. Box B starts for the same thread, restores the save and runs
   `claude --resume <session id>`, asking for the codeword and the number
   from memory.

```sh
CLAUDE_TOKEN_FILE=~/.config/threadbear-box-spike/claude-token node lose-box.ts
```

Every check passed on the first run: box B answered "pelican-42 7319" in
the same session, `notes.txt` was still there and still uncommitted (one
commit, as before), box B's key worked and box A's was refused. The save
was 57 KB and took 4 s from request to stored.

| | Box A | Box B |
|---|---|---|
| Create to answer | 58 s | 54 s |
| of which installing git and Claude Code | 43 s | 45 s |
| Restore from the save | | 1 s after the exchange |

The installs would be baked into a real image, which puts a cold wake from
a save at roughly 10 s plus the turn. Not tested here: pushing
`refs/threadbear/save` to the repo's origin (that needs the GitHub tokens of
decision 11), and the real runner's own save and restore.

## Cold start and warm wake of the real runner (18 Nov 2026)

`cold-start.ts` with `box/cold.mjs`: the real runner (`runner/src/main.ts`
from a fresh clone of threadbear, running on its own as in
`runner/test/e2e`, no Convex) in a Fly box (`node:24`, shared-cpu-2x,
2 GB). The Claude token comes by the boot exchange and goes in
claude-main's `threadbear-token.json`, which the runner reads for
year-long tokens. A thread opened in the repo gets its own worktree
(`threadbear-threads/slot-2`), the repo's `worktree-setup.sh` runs, and
Haiku answers. Then the driver pauses the box for 60 s, resumes it, and
the box sends a second message on the same thread.

```sh
CLAUDE_TOKEN_FILE=~/.config/threadbear-box-spike/claude-token node cold-start.ts
```

Every check passed. Timings, from the box's own clock unless marked:

| Step | Time | In a real box image |
|---|---|---|
| Create call to the script starting (driver) | 17 s | |
| Boot exchange | 2.4 s | |
| Install Claude Code | 19.5 s | baked in |
| `git clone --filter=blob:none` threadbear | 15.7 s | per thread |
| `npm ci` for the runner | 51.7 s | baked in |
| Runner start to listening | 0.9 s | |
| New thread to first text | 46 s | per thread |
| of which worktree setup (`npm ci` at the root) | 11.2 s | per thread |
| **Create to first reply (driver)** | **159 s** | about 88 s |
| Pause / resume calls | 1.9 s / 1.1 s | |
| **Resume to second reply done (driver)** | **5.3 s** | |

About 30 s of "new thread to first text" isn't explained by the setup or
the turn (Haiku answers in about 2 s, and the CLI starts in a few). The
box was gone before I could read the runner's log, so that's the first
thing to look at in box mode. The repo's patches were already trusted:
the runner trusts its own checkout.

Cost on Fly ([pricing](https://docs.fly.io/about/pricing)):
shared-cpu-2x with 2 GB is $13.39 a month running, about 1.9 cents an
hour awake. Paused, only the root disk is billed, at $0.15 per GB-month:
for a few GB, well under a tenth of a cent an hour. A save in Convex file
storage is a few MB per thread, so asleep-and-saved costs next to nothing.
