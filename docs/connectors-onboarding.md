# Connectors for everyone (proposal)

29 Oct 2026, thread 0ee93bb5. Decided the same day (section 3); nothing built yet.

What Mike asked: should the Connectors gateway be part of Threadbear's onboarding,
explaining why someone would want it, and optional? And the gateway itself should be a
public repo so other people can run it easily.

## 1. Where things stand

- **The gateway** (public since 29 Oct as `mikecann/plugbear`, called Plugboard until 30 Oct; working copy `~/dev/me/connectors`) runs on Bruce
  behind `tailscale serve`. It signs in to each service once and gives every agent one
  MCP URL, with "ask Mike first" rules for sending and a call log. Since 29 Oct it has
  Notion, Sentry, Cloudflare, DeepWiki, and Gmail plus Google Calendar through Mike's own
  Google Cloud project (`connectors-513022`). Each agent login is wired to it by
  `scripts/install-clients.sh`.
- **Threadbear** knows about it only at the edges: the Connectors panel (the plug icon)
  reads the gateway's `/health`, found through the `connectors` entry in
  `~/.claude.json`, and `end_turn` nudges an agent that hit a sign-in error to hand Mike
  the link. Without a gateway the panel says there isn't one, and everything else works
  as before.
- **Setup** (`./threadbear setup`, docs/setup-and-updates.md) doesn't mention
  connectors. A new user gets claude.ai's connectors on each login, as in plain
  Claude Code.
- **Mike-only parts of the gateway:** admin access is checked against Mike's Tailscale
  login, `config/agents.json` lists his logins (claude-main, claude-1..3, Codex, Grok,
  Muse), the deploy script and LaunchAgent assume Bruce, and the docs and tests name his
  tailnet, his emails and his machines. No secrets are in the repo: they live in
  `~/Library/Application Support/Connectors/secrets/` on Bruce.

## 2. The proposal in one go

The gateway stays optional, and it's offered to everyone. One gateway serves every
agent at once (Claude logins, Codex, and others such as Grok), so it pays off as soon as
someone uses more than one: one sign-in instead of one per login and per provider. With
several Claude logins in a pool it matters even more, because a pool moves a thread
between logins and claude.ai connectors are signed in per login, so a thread may or may
not have your Gmail depending on where it lands. That's exactly what happened to Mike on
29 Oct.

By default it runs on the same Mac as the runner, on localhost, installed and updated
with Threadbear. A second always-on machine (Mike's Bruce) is an option, not a
requirement. Setting it up is a thread, like the agent-driven install: the user says
yes, the agent installs it, wires each login and hands over Connect buttons.

The gateway becomes a public repo of its own, so people can run it without Threadbear
too, and Threadbear installs a pinned version of it.

### 2.1 Where it's offered

- **Finish setting up** gets an optional item for everyone, "Share your connectors
  across agents". One line, the reasons behind the ⓘ: one sign-in for every Claude login,
  Codex and other agents, asks you before anything is sent, a log of every call.
  Dismissing it hides it for good.
- **The Connectors panel**, with no gateway, shows a "Set up" button with the same ⓘ,
  instead of only saying there isn't one.
- **The end_turn nudge** for a claude.ai sign-in error can mention it once ("this keeps
  happening with several logins; the gateway fixes it"), at most once a week.

### 2.2 Where it runs

| | On this Mac (default) | On another machine (option) |
|---|---|---|
| Address | `http://127.0.0.1:<port>` | `https://<machine>.<tailnet>.ts.net:<port>` |
| Needs | nothing extra | Tailscale on both, the machine always on |
| Admin pages | open to this Mac's user only (loopback plus a per-install key the runner and the browser share) | Tailscale login check, as on Bruce today |
| When the Mac sleeps | agents on this Mac sleep too, so nothing's lost | other machines' agents keep working |

The runner already supervises itself with a LaunchAgent; the gateway gets its own
LaunchAgent, installed by setup, and follows the same update path as the runner
(pinned version, rebuilt when Threadbear updates).

### 2.3 What the setup thread does

1. Installs the gateway (from the pinned public release) and its LaunchAgent.
2. Adds an agent entry and token for each login Threadbear knows about (the Accounts
   list), and wires each login's `.claude.json`, and Codex's config, the way
   `install-clients.sh` does now.
3. Opens the Connectors panel, where the user presses Connect for the services they
   want. Notion, Sentry, Cloudflare and other services that support standard MCP
   sign-in need nothing else.
4. Suggests turning off the matching claude.ai connectors so there's one place to sign
   in.

### 2.4 Google (Gmail, Calendar)

Google is the hard part. Its hosted Gmail and Calendar MCP servers only take Workspace
accounts in its developer preview, so the gateway runs its own small servers, and each
user needs their own Google Cloud project and OAuth client. One shared client for
everyone would need Google's paid security assessment for Gmail access. The "Google
hasn't verified this app" screen on sign-in stays, since it's the user's own unverified
app.

Proposed: leave Google out of the first version (people keep claude.ai's Gmail
connector), then add it as an optional agent-guided step that drives the Cloud console
in the user's browser, as was done for Mike on 29 Oct: project, Gmail and Calendar
APIs, consent screen published so sign-in lasts, a web client marked for AI agents,
client file into the gateway's secrets.

### 2.5 Making the gateway public

Before flipping `mikecann/connectors` to public:

- Move Mike's details out of the code into a local config file that isn't committed:
  tailnet hostname, admin logins, the agent list, Bruce paths in `deploy.sh` and the
  LaunchAgent. Ship examples instead (`config/agents.example.json`).
- Rewrite the docs for a stranger: README with what it does, local install, the
  Tailscale option, adding a service. `docs/archive/plan.md` keeps the design, without Mike's
  machines.
- Tests use made-up names (most already do).
- Publish with a fresh history (one commit) rather than the current 12, so nothing
  personal lingers in old commits, and run a secret scanner over it first.
- A licence (MIT, like Mike's other public tools, unless he'd rather not).

## 3. Decisions

Decided 29 Oct. Mike: "offer to everyone as an optional item ... connectors can span
across multiple providers, so Claude and Codex and whatever". He left the rest to these
picks:

- Offered to everyone as an optional Finish setting up item, not only with two or more
  logins (2.1).
- Runs on this Mac by default; another machine over Tailscale is an option (2.2).
- Google is left out of the first version and added later as a guided step (2.4).
- The public repo gets a less generic name than `connectors` (to pick when it's
  published) and the MIT licence. It goes public once the cleanup in 2.5 is done, which
  can be before Threadbear's own install is ready, since it's useful on its own.

## 4. A rough order to build it in

1. Gateway: config out of the code, local (loopback) admin mode, examples, README.
2. Gateway: fresh public repo, release tags Threadbear can pin.
3. Threadbear setup: install the gateway and its LaunchAgent, wire the logins (behind
   the Finish setting up item).
4. Connectors panel: "Set up" when there's no gateway; the claude.ai nudge.
5. Google as an optional guided step.

This fits after the own-deployment install work (docs/setup-and-updates.md, steps 3
to 5), since it's only useful once other people can install Threadbear.
