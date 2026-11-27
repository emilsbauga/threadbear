// Reply buttons (docs/protocol/events.md, "Reply buttons"): an agent's add_button
// makes one, its reply links button:<id>, and Mike's press starts a thread
// with the brief or sends the message, once, or opens another folder's patch
// panel beside the thread, every time.
// Part of the Runner (runner.ts); each method's `this` is the Runner.
import type { Runner } from '../runner.ts';
import type { RunnerPart } from './part.ts';
import type { EffortLevel, PanelRequest, PermissionMode, ReplyButton } from '../protocol.ts';
import { AGENT_MESSAGE_PREFIX, ErrorCode, RpcError } from '../protocol.ts';
import { isDirectory } from '../fsutil.ts';
import { findPool } from '../pools.ts';
import type { ThreadState } from '../runner.ts';
import { PANEL_ACK_WAIT_MS } from '../panel-requests.ts';
import crypto from 'node:crypto';
import path from 'node:path';

export const MAX_BUTTON_TITLE = 60;
export const MAX_BUTTON_TEXT = 20_000;
// Kept per thread, newest. A daily brief makes about six a day.
export const MAX_BUTTONS = 200;

// Each thread's newest panel button press, counted: only its panel is shown,
// so a slow earlier one can't open over it.
const lastPress = new WeakMap<ThreadState, number>();

// Ranked like threadbear-mcp.ts's ACCESS: plan only changes what Mike approves.
const RANK: Record<PermissionMode, number> = { ask: 0, plan: 0, auto: 1, full: 2 };
const MODE_NAMES: Record<PermissionMode, string> = { full: 'Full access', auto: 'Auto', ask: 'Ask before edits', plan: 'Plan first' };

export type ButtonInput = {
  title: string;
  // A new thread with this brief...
  start?: { text: string; title?: string; cwd?: string; accountId?: string; poolId?: string; model?: string; effort?: EffortLevel; permissionMode?: PermissionMode; why?: string };
  // ...or a message to this thread...
  send?: { threadId: string; text: string };
  // ...or another folder's web panel, as folderPanel found it.
  panel?: { cwd: string; panelId: string; title: string };
};

// A panel button's panel as the thread it's opened beside lists it: its own
// id, so it's never taken for the folder's own panel (the YouTube patch's
// page lists the threads that have its panel as ones to ask in).
export function borrowedPanelId(cwd: string, panelId: string): string {
  return `${panelId}@${crypto.createHash('sha256').update(cwd).digest('hex').slice(0, 8)}`;
}

const clean = (s: string | undefined): string | undefined => (s?.trim() ? s.trim() : undefined);

export const buttonsPart = {
  // Only the thread's own agent calls this (add_button, bound to its
  // thread); there's no RPC that makes one, so nothing outside the thread
  // can put a button in its replies.
  createButton(this: Runner, threadId: string, input: ButtonInput): { button: ReplyButton } {
    const st = this.mustGet(threadId);
    this.checkAccepting();
    const title = clean(input.title)?.replace(/\s+/g, ' ');
    if (!title) throw new RpcError(ErrorCode.badParams, 'A button needs a title.');
    if (title.length > MAX_BUTTON_TITLE) throw new RpcError(ErrorCode.badParams, `A button's title is at most ${MAX_BUTTON_TITLE} characters.`);
    if ([input.start, input.send, input.panel].filter(Boolean).length !== 1) throw new RpcError(ErrorCode.badParams, 'Give a button one of start (a new thread), send (a message to a thread) or panel (a folder\'s patch panel).');
    // What the maker's agent can do now: a button can't hand Mike a
    // thread or a message with more access than that, as its title is the
    // agent's and he presses it trusting it (threadbear-mcp.ts, "Raising access").
    // Its saved mode, as send_message judges it, not accessOf: a turn begun
    // with more keeps that until it ends, after Mike lowers the thread
    // (Codex's review, 26 Nov 2026).
    const maker = st.rec.permissionMode;
    const button: ReplyButton = { id: this.newButtonId(st), title, createdAt: this.isoNow(), ...(st.rt.turn ? { turnId: st.rt.turn.turnId } : {}) };
    if (input.start) {
      const s = input.start;
      const text = clean(s.text);
      if (!text) throw new RpcError(ErrorCode.badParams, 'start needs text: the brief for the new thread.');
      if (text.length > MAX_BUTTON_TEXT) throw new RpcError(ErrorCode.badParams, `The brief is at most ${MAX_BUTTON_TEXT} characters.`);
      const cwd = path.resolve(st.rec.cwd, s.cwd?.trim() || '.');
      if (!isDirectory(cwd)) throw new RpcError(ErrorCode.badParams, `Folder not found: ${cwd}`);
      if (s.accountId !== undefined && !this.accounts.get(s.accountId)) throw new RpcError(ErrorCode.accountNotFound, `No account called ${s.accountId}`);
      if (s.poolId !== undefined && !findPool(this.hello().pools ?? [], s.poolId)) throw new RpcError(ErrorCode.badParams, `No pool ${s.poolId}`);
      if (s.accountId && s.model && !this.modelFits(this.accounts.get(s.accountId)!, s.model)) throw new RpcError(ErrorCode.badParams, `${s.accountId} doesn't have the model ${s.model}.`);
      const permissionMode = s.permissionMode ?? (maker === 'full' ? 'full' : maker);
      if (RANK[permissionMode] > RANK[maker]) throw new RpcError(ErrorCode.badParams, `This thread has ${MODE_NAMES[maker]}, so its buttons can't start a thread with ${MODE_NAMES[permissionMode]}.`);
      button.start = {
        text,
        ...(clean(s.title) ? { title: clean(s.title)!.slice(0, 200) } : {}),
        cwd,
        ...(s.accountId ? { accountId: s.accountId } : {}),
        ...(s.poolId && !s.accountId ? { poolId: findPool(this.hello().pools ?? [], s.poolId)!.id } : {}),
        ...(clean(s.model) ? { model: clean(s.model)! } : {}),
        ...(s.effort ? { effort: s.effort } : {}),
        permissionMode,
        ...(clean(s.why) ? { why: clean(s.why)!.replace(/\s+/g, ' ').slice(0, 80) } : {}),
      };
    } else if (input.panel) {
      const p = input.panel;
      if (!isDirectory(p.cwd)) throw new RpcError(ErrorCode.badParams, `Folder not found: ${p.cwd}`);
      if (!clean(p.panelId)) throw new RpcError(ErrorCode.badParams, 'panel needs the panel to open.');
      button.panel = { cwd: p.cwd, panelId: p.panelId.trim(), title: clean(p.title)?.slice(0, 60) ?? p.panelId.trim() };
    } else {
      const s = input.send!;
      const text = clean(s.text);
      if (!text) throw new RpcError(ErrorCode.badParams, 'send needs text: the message.');
      if (text.length > MAX_BUTTON_TEXT) throw new RpcError(ErrorCode.badParams, `The message is at most ${MAX_BUTTON_TEXT} characters.`);
      const target = this.threads.get(s.threadId);
      if (!target) throw new RpcError(ErrorCode.threadNotFound, `No thread ${s.threadId} on this runner.`);
      if (target.rec.id === threadId) throw new RpcError(ErrorCode.badParams, "A button can't message its own thread.");
      const theirs = this.accessOf(target.rec.id);
      if (RANK[theirs] > RANK[maker]) throw new RpcError(ErrorCode.badParams, `"${target.rec.title}" has ${MODE_NAMES[theirs]} and this thread has ${MODE_NAMES[maker]}, so a button here can't message it. send_message asks the user first.`);
      button.send = { threadId: target.rec.id, threadTitle: target.rec.title, text };
    }
    this.persistButton(st, button);
    return { button: structuredClone(button) };
  },

  listButtons(this: Runner, threadId: string): { buttons: ReplyButton[] } {
    return { buttons: structuredClone(this.mustGet(threadId).rec.buttons ?? []) };
  },

  // Mike's press, from the Mac, the phone or the website. Once only: a
  // button already pressed comes back as it is, so a retried request or a
  // press from two places never starts two threads.
  pressButton(this: Runner, threadId: string, buttonId: string): { button: ReplyButton } {
    const st = this.mustGet(threadId);
    const button = st.rec.buttons?.find((b) => b.id === buttonId);
    if (!button) throw new RpcError(ErrorCode.badParams, `Button not found: ${buttonId}`);
    if (button.panel) return this.pressPanelButton(st, button);
    if (button.pressed) return { button: structuredClone(button) };
    // A Run from the card's command, which was taken out (14 Nov 2026):
    // one saved before then has neither, so it does nothing now.
    if (!button.start && !button.send) throw new RpcError(ErrorCode.badParams, 'This button no longer does anything.');
    // Access is checked again now, not only when it was made: the maker or
    // the target may have changed mode since (Codex's review, 7 Nov 2026).
    // A refusal here is saved as a failed press, like any other.
    const maker = st.rec.permissionMode;
    const over = button.start && RANK[button.start.permissionMode] > RANK[maker]
      ? `This thread now has ${MODE_NAMES[maker]}, so its button can't start a thread with ${MODE_NAMES[button.start.permissionMode]}.`
      : button.send && this.threads.has(button.send.threadId) && RANK[this.accessOf(button.send.threadId)] > RANK[maker]
        ? `"${button.send.threadTitle}" now has more access than this thread, so its button can't message it. Ask in this thread for it to use send_message.`
        : undefined;
    if (over) {
      this.persistButton(st, { ...button, failed: { at: this.isoNow(), error: over } });
      throw new RpcError(ErrorCode.badParams, over);
    }
    // The words are the agent's, so they say so, as send_message's do.
    const from = `${AGENT_MESSAGE_PREFIX}"${st.rec.title}" (${st.rec.id.slice(0, 8)})]\n\n`;
    let next: ReplyButton;
    try {
      if (button.start) {
        const s = button.start;
        // Nothing waits between here and the press being saved (create is
        // synchronous), so a second press can't slip in.
        const r = this.create({
          text: from + s.text,
          ...(s.title ? { title: s.title } : { title: button.title }),
          cwd: s.cwd,
          ...(s.accountId ? { accountId: s.accountId } : {}),
          ...(s.poolId ? { poolId: s.poolId } : {}),
          ...(s.model ? { model: s.model } : {}),
          ...(s.effort ? { effort: s.effort } : {}),
          permissionMode: s.permissionMode,
          startedBy: { kind: 'thread', label: 'Button', threadId: st.rec.id, threadTitle: st.rec.title, ...(s.why ? { why: s.why } : {}) },
        });
        next = { ...button, pressed: { at: this.isoNow(), threadId: r.thread.id } };
      } else {
        const s = button.send!;
        this.send(s.threadId, from + s.text);
        next = { ...button, pressed: { at: this.isoNow(), threadId: s.threadId } };
      }
      delete next.failed;
    } catch (e) {
      const error = (e as Error).message ?? String(e);
      this.persistButton(st, { ...button, failed: { at: this.isoNow(), error: error.slice(0, 300) } });
      throw e instanceof RpcError ? e : new RpcError(ErrorCode.badParams, error);
    }
    // For the agent, before Mike's next message (Runner.takePressNews).
    this.notePress(st.rec, next);
    this.persistButton(st, next);
    return { button: structuredClone(next) };
  },

  // A panel button: the folder's panel joins this thread's (readPatches
  // adds every pressed one's, running its badge and summary as that
  // folder's threads would, which is what starts a patch's server), and is
  // put in front of Mike as show_panel would. Every press does that again,
  // so it isn't once only: it opens the panel, it doesn't do a job.
  pressPanelButton(this: Runner, st: ThreadState, button: ReplyButton): { button: ReplyButton } {
    const p = button.panel!;
    if (!isDirectory(p.cwd)) {
      const error = `The folder ${p.cwd} has gone.`;
      this.persistButton(st, { ...button, failed: { at: this.isoNow(), error } });
      throw new RpcError(ErrorCode.badParams, error);
    }
    const next: ReplyButton = { ...button, pressed: { at: this.isoNow(), threadId: st.rec.id } };
    delete next.failed;
    this.persistButton(st, next);
    void this.showPanelButton(st, next);
    return { button: structuredClone(next) };
  },

  // Shows the panel as soon as it's found: from its own folder, once its
  // badge and summary have run there (what starts a patch's server, and
  // what a `when` hiding it is read with), never after the rest of the
  // thread's patches: waiting for the thread's whole read left the Daily
  // brief's Go through comments doing nothing for 13 minutes on a busy
  // runner (23 Nov 2026). The thread reads its patches again behind it,
  // which keeps the panel from then on. A panel that isn't there (its patch
  // broke or went, or hid it) is saved as a failed press, for Mike to see
  // on the pill.
  async showPanelButton(this: Runner, st: ThreadState, button: ReplyButton): Promise<void> {
    const p = button.panel!;
    const cwd = st.rec.cwd;
    const own = p.cwd === cwd;
    const id = own ? p.panelId : borrowedPanelId(p.cwd, p.panelId);
    // Alongside, before patchSet could start a read of its own: one read,
    // which brings the panel for good. The badge's command is shared
    // between it and the look below (runLiveCommand).
    this.rereadPatches(st);
    let panel = this.patchSet(st).panels.find((x) => x.id === id);
    const press = (lastPress.get(st) ?? 0) + 1;
    lastPress.set(st, press);
    if (!own) {
      // Every press: its badge again (a server that has stopped starts),
      // and its `when` and trust looked at again.
      panel = await this.borrowedPanel(st, p.cwd, p.panelId);
      if (panel && !st.rt.deleted && st.rec.cwd === cwd) this.addBorrowedPanel(st, panel);
    } else {
      // The thread's own folder: its badge and `when` the same way, and the
      // panel as the thread has it, or, missing, as its next read says.
      const live = await this.folderPanelLive(st, p.cwd, p.panelId);
      panel = live && this.patchSet(st).panels.find((x) => x.id === id);
      if (live && !panel) {
        try {
          await this.threadPatchesIdle(st);
        } catch (e) {
          this.log.warn('could not read patches for a panel button', { threadId: st.rec.id, error: String(e) });
        }
        panel = this.patchSet(st).panels.find((x) => x.id === id);
      }
    }
    // A later press (of this button or another) shows its own panel.
    if (lastPress.get(st) !== press) return;
    // Moved to another folder meanwhile: what was looked up was for the old one.
    if (st.rt.deleted || st.rec.cwd !== cwd) return;
    if (!panel) {
      const now = st.rec.buttons?.find((b) => b.id === button.id) ?? button;
      this.persistButton(st, { ...now, failed: { at: this.isoNow(), error: `${p.title} isn't a panel in ${path.basename(p.cwd)} just now.` } });
      return;
    }
    const request: PanelRequest = { id: crypto.randomUUID(), panel: panel.id, title: panel.title, at: this.isoNow() };
    void this.requestPanel(st, request, PANEL_ACK_WAIT_MS);
  },

  // A folder's web panel by its id or title (any case), for add_button's
  // panel: the folder's patches read as a thread there would have them.
  async folderPanel(this: Runner, cwd: string, name: string): Promise<{ cwd: string; panelId: string; title: string }> {
    if (!isDirectory(cwd)) throw new RpcError(ErrorCode.badParams, `Folder not found: ${cwd}`);
    const set = await this.loadSharedPatchSet(cwd, [], this.projects?.allFolders() ?? []);
    const wanted = name.trim().toLowerCase();
    const hit = set.panels.find((x) => x.id.toLowerCase() === wanted) ?? set.panels.find((x) => x.title.toLowerCase() === wanted);
    const web = set.panels.filter((x) => x.kind === 'url');
    const names = web.map((x) => `${x.id} (${x.title})`).join(', ');
    if (!hit) throw new RpcError(ErrorCode.badParams, `No panel called ${name.trim()} in ${cwd}. ${names ? `Its web panels: ${names}.` : 'It has no web panels.'}`);
    if (hit.kind !== 'url') throw new RpcError(ErrorCode.badParams, `${hit.title} is a list panel; a button can only open a web panel from another folder.${names ? ` Its web panels: ${names}.` : ''}`);
    return { cwd, panelId: hit.id, title: hit.title };
  },

  // The pressed panel buttons' panels, newest press first, one per panel.
  borrowedPanels(this: Runner, st: ThreadState): { cwd: string; panelId: string }[] {
    const seen = new Set<string>();
    const out: { cwd: string; panelId: string }[] = [];
    for (const b of [...(st.rec.buttons ?? [])].reverse()) {
      if (!b.panel || !b.pressed || b.panel.cwd === st.rec.cwd) continue;
      const key = `${b.panel.cwd}\u0000${b.panel.panelId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ cwd: b.panel.cwd, panelId: b.panel.panelId });
    }
    return out;
  },

  newButtonId(this: Runner, st: ThreadState): string {
    const taken = new Set((st.rec.buttons ?? []).map((b) => b.id));
    for (;;) {
      // 8 of [a-z0-9]: short enough for the agent to copy into a link.
      const id = Array.from(crypto.randomBytes(8), (b) => 'abcdefghijklmnopqrstuvwxyz0123456789'[b % 36]).join('');
      if (!taken.has(id)) return id;
    }
  },

  persistButton(this: Runner, st: ThreadState, button: ReplyButton): void {
    const previous = st.rec.buttons ?? [];
    const buttons = (previous.some((b) => b.id === button.id) ? previous.map((b) => (b.id === button.id ? button : b)) : [...previous, button]).slice(-MAX_BUTTONS);
    this.store.save({ ...st.rec, buttons });
    st.rec.buttons = buttons;
    this.emit(st, { type: 'button.updated', button });
  },
};

export type ButtonsPart = RunnerPart<typeof buttonsPart>;
