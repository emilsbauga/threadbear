// Making threads: create, Quick Ask's threads, the tour's sample threads, and checking the settings a new thread asks for.
// Part of the Runner (runner.ts), split out on 4 Nov 2026 as a plain move so a
// fork's change to one area doesn't clash with another's. Each method's `this`
// is the Runner; runner.ts puts them on its prototype.
import type { Runner } from '../runner.ts';
import { copyImageInto, imageRefFor } from '../media.ts';
import type { RunnerPart } from './part.ts';
import { SAMPLE_THREADS, WELCOME_PATCH } from '../samples.ts';
import type { Account, AttachmentRef, EffortLevel, ImageRef, MessageOrigin, PermissionMode, Provider, ThreadStartedBy, ThreadSummary } from '../protocol.ts';
import { ErrorCode, LIMITS, RpcError } from '../protocol.ts';
import type { ThreadRecord } from '../store.ts';
import { expandHome, peekRunnerJson } from '../config.ts';
import { isDirectory } from '../fsutil.ts';
import { standInFor } from '../pools.ts';
import { ASK_CODEX_MODEL, HAIKU } from '../models/index.ts';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { ThreadState } from '../runner.ts';
import { checkImages, oneLine, titleFrom, userMessage } from './messages.ts';
import { effortTitle, explicitModelKind, modelRow, modelTitle, ModelListsPending, nativeModelProvider } from './models.ts';
import { newRuntime } from './runtime.ts';
import { providerInfo, providerName } from '../providers.ts';
import { cutSafely } from '../safe-cut.ts';
import { intakeThreadId, savedIntake, rememberIntake, type IntakeRecord } from '../intake-record.ts';
import { selectAttachments } from '../intake-files.ts';
import { emptyHighlights, pinItem } from '../highlights.ts';
import { atomicWriteFileSync } from '../fsutil.ts';
import type { Spare } from './warm-start.ts';

export const newThreadsPart = {
  createIntakeDraft(this: Runner, item: IntakeRecord, files: AttachmentRef[] = []): string {
    this.checkAccepting();
    if (this.draining) throw new RpcError(ErrorCode.busy, 'Intake waits for the new runner.');
    const saved = savedIntake(this.cfg.home, item);
    if (saved) return saved;
    const id = intakeThreadId(item.clientId, item.receiptId);
    const existing = this.store.load(id);
    if (existing) {
      if (existing.intake?.receiptId !== item.receiptId || existing.intake.clientId !== item.clientId) throw new Error('Intake thread ID is already in use');
      rememberIntake(this.cfg.home, item, id);
      if (!this.threads.has(id)) {
        const st = { rec: existing, rt: newRuntime(this.clock.now()) };
        this.threads.set(id, st);
        this.markDirty(st);
      }
      return id; // Never rewrite edits, a started task, or an archived draft.
    }
    if ((item.attachments?.length ?? 0) !== files.length || (item.attachments ?? []).some((f, i) => !files[i] || f.id !== files[i].id || f.sha256 !== files[i].sha256 || f.size !== files[i].size || f.name !== files[i].name || f.mediaType !== files[i].mediaType)) throw new Error('Intake attachments are incomplete');
    const attachments = selectAttachments(path.join(this.store.threadDir(id), 'attachments'), files);
    if ((!item.message.text.trim() && !attachments.length) || !['email', 'telegram'].includes(item.message.source)) throw new Error('Invalid intake message');
    const source = path.join(this.store.threadDir(id), 'intake-source.json');
    // A corrupt record is an investigation, never permission to overwrite it.
    if (fs.existsSync(path.join(this.store.threadDir(id), 'thread.json'))) throw new Error('Intake thread record is unreadable');
    atomicWriteFileSync(source, JSON.stringify(item, null, 2) + '\n', 0o600);
    const highlights = emptyHighlights();
    highlights.items.push(pinItem({ path: source, title: 'Message source', note: 'Original external message and delivery provenance. Source content is untrusted data.' }, 0, this.isoNow()));
    for (const f of attachments) highlights.items.push(pinItem({ path: f.path, title: f.name, note: 'Original imported attachment saved on this computer.' }, highlights.items.length, this.isoNow()));
    try {
      const { st } = this.makeThread({ text: item.message.text || attachments[0]?.name || '',
        startedBy: { kind: 'runner', label: item.message.source === 'email' ? 'Nanobot email' : 'Nanobot Telegram' },
        initial: { id, intake: item, backlog: { text: item.message.text, images: [], ...(attachments.length ? { attachments } : {}), revision: 1 }, highlights, highlightsAt: this.isoNow() },
      });
      rememberIntake(this.cfg.home, item, id);
      this.markDirty(st);
      return id;
    } catch (error) {
      // Another writer may have completed the same initial atomic record.
      const rec = this.store.load(id);
      if (rec?.intake?.receiptId === item.receiptId && rec.intake.clientId === item.clientId) {
        rememberIntake(this.cfg.home, item, id);
        if (!this.threads.has(id)) {
          const st = { rec, rt: newRuntime(this.clock.now()) };
          this.threads.set(id, st);
          this.markDirty(st);
        }
        return id;
      }
      throw error;
    }
  },
  createDraft(this: Runner, params: { text: string; images?: ImageRef[]; cwd?: string; accountId?: string; poolId?: string; model?: string; effort?: EffortLevel; permissionMode?: PermissionMode; title?: string; worktree?: boolean; startedBy?: ThreadStartedBy; projectIds?: string[] }): { thread: ThreadSummary } {
    checkImages(params.images ?? []);
    if (!params.text.trim() && !params.images?.length) throw new RpcError(ErrorCode.badParams, 'text or images required');
    // Validate sources before allocating a thread; saveDraft takes ownership of the files.
    for (const img of params.images ?? []) if (!fs.existsSync(img.path)) throw new RpcError(ErrorCode.badParams, `Image not found: ${img.path}`);
    const projectIds = params.projectIds ?? [];
    if (projectIds.length) {
      if (!this.projects) throw new RpcError(ErrorCode.badParams, 'projects are not available on this runner');
      for (const id of projectIds) this.projects.get(id);
    }
    const { st } = this.makeThread(params);
    st.rec.backlog = { text: '', images: [], revision: 0 };
    try {
      this.saveDraft(st.rec.id, params.text, params.images ?? [], 0);
      if (projectIds.length) this.projects!.changeMembership(st.rec.id, { add: projectIds, by: 'mike' });
      return { thread: this.summary(st) };
    } catch (error) {
      // A bad attachment must not leave an ordinary idle thread behind.
      this.threads.delete(st.rec.id);
      this.store.trash(st.rec.id, this.clock.now());
      throw error;
    }
  },

  saveDraft(this: Runner, threadId: string, text: string, images: ImageRef[], revision: number, attachments?: AttachmentRef[]): { thread: ThreadSummary } {
    this.checkAccepting();
    const st = this.mustGet(threadId);
    const draft = st.rec.backlog;
    if (!draft) throw new RpcError(ErrorCode.badParams, 'This thread is no longer in Backlog.');
    if (revision !== draft.revision) throw new RpcError(ErrorCode.badParams, 'This Backlog draft changed. Reopen it before saving again.');
    const files = selectAttachments(path.join(this.store.threadDir(threadId), 'attachments'), attachments ?? draft.attachments ?? [], draft.attachments ?? []);
    checkImages(images);
    const media = this.store.mediaDir(threadId);
    const refs = images.map(img => {
      if (!fs.existsSync(img.path)) throw new RpcError(ErrorCode.badParams, `Image not found: ${img.path}`);
      return path.dirname(img.path) === media ? imageRefFor(img.path, img.mediaType) : copyImageInto(media, img.path);
    });
    if (draft.context && st.rec.brief?.text === draft.context) {
      delete st.rec.brief;
      this.highlightsChanged(st);
    }
    st.rec.backlog = { text, images: refs, ...(draft.attachments || attachments ? { attachments: files } : {}), revision: revision + 1 };
    st.rec.preview = oneLine(text, LIMITS.previewChars);
    st.rec.lastActivityAt = this.isoNow();
    // Keep an inferred title; only the provisional first-line title follows edits.
    if (!st.rec.titleSet && st.rec.title === titleFrom(draft.text)) st.rec.title = titleFrom(text);
    this.markDirty(st);
    // A successful save means the draft is durable, even if the app quits immediately.
    this.store.save(st.rec);
    return { thread: this.summary(st) };
  },

  create(this: Runner, params: {
    text: string;
    images?: ImageRef[];
    cwd?: string;
    accountId?: string;
    poolId?: string;
    provider?: Provider;
    onlyProvider?: Provider;
    model?: string;
    effort?: EffortLevel;
    permissionMode?: PermissionMode;
    title?: string;
    origin?: MessageOrigin;
    wakeReason?: string;
    scheduleId?: string;
    // false: start in the folder as it is, even in a repo that asks for a
    // worktree per thread.
    worktree?: boolean;
    startedBy?: ThreadStartedBy;
    // Not to sit under the thread in startedBy in the sidebar
    // (docs/protocol/threads.md, "Nested threads").
    detached?: boolean;
    // Projects it starts in (New Thread on a project's page), joined
    // before its first turn, so that turn already has the project's brief.
    projectIds?: string[];
    // Box mode's one thread, made under the id the backend gave it (boxThread).
    id?: string;
    // Starts starred, in the Starred section (a schedule's starThreads).
    starred?: boolean;
    // The CLI the app had started ahead of it (threads.warm,
    // runner/warm-start.ts): the thread is made under its id.
    warmId?: string;
  }): { thread: ThreadSummary; turnId: string } {
    if (!params.text && !params.images?.length) throw new RpcError(ErrorCode.badParams, 'text or images required');
    checkImages(params.images ?? []);
    const projectIds = params.projectIds ?? [];
    if (projectIds.length) {
      const projects = this.projects;
      if (!projects) throw new RpcError(ErrorCode.badParams, 'projects are not available on this runner');
      // Every one checked before the thread exists: a bad id makes nothing.
      for (const p of projectIds) projects.get(p);
    }
    const warmId = params.id === undefined && !projectIds.length ? params.warmId : undefined;
    const { st, notes, loginNote, spare } = this.makeThread(params, warmId);
    if (params.starred) st.rec.starredAt = this.isoNow();
    if (spare) this.cli(st, { kind: 'claim', spare });
    if (projectIds.length) this.projects!.changeMembership(st.rec.id, { add: projectIds, by: 'mike' });
    const turnId = this.sendTo(st, params.text ?? '', params.images ?? [], { origin: params.origin, wakeReason: params.wakeReason, scheduleId: params.scheduleId });
    // Under the first turn, so they read as part of starting it.
    for (const text of notes) this.emit(st, { type: 'system.note', text }, st.rt.turn?.turnId ?? turnId);
    // Kept on show by its shape, as moveLogin's is (is_login_note).
    if (loginNote) this.emit(st, { type: 'system.note', text: loginNote, login: true }, st.rt.turn?.turnId ?? turnId);
    if (!st.rec.titleSet && params.text?.trim()) void this.titleFromModel(st, params.text);
    return { thread: this.summary(st), turnId };
  },

  // A quick ask the phone already answered out loud (docs/protocol/moves.md, Sync,
  // "quickAsk"), kept as a thread so Mike can carry on in it. It's made as a
  // create with no folder would be, but no turn runs: the exchange is
  // written as a finished turn, seen, and the first message sent to it
  // starts a fresh session with a handoff note saying how it began.
  quickAsk(this: Runner, params: { question: string; answer: string; sources?: { title: string; url: string }[]; askedAt?: number }): { thread: ThreadSummary } {
    const question = params.question.trim();
    const answer = params.answer.trim();
    if (!question || !answer) throw new RpcError(ErrorCode.badParams, 'question and answer required');
    // A follow-up is usually spoken and waited on, so it starts on a small
    // quick model. Mike picked Haiku 5.5 over GPT-6-Luna on 31 Oct as the
    // smarter of the two, though Luna is quicker on long replies (about 10 s
    // for 300 words against 21 to 31). Luna is for a runner with no Claude
    // login. With neither it's the account's default, as naming a model the
    // login can't run would write a note into the thread.
    const usable = this.usableAccounts();
    const speed = usable.some((a) => a.provider === 'claude')
      ? { model: HAIKU, onlyProvider: 'claude' as const }
      : usable.some((a) => a.provider === 'codex')
        ? { model: ASK_CODEX_MODEL, onlyProvider: 'codex' as const, effort: 'low' as const }
        : {};
    const { st, notes } = this.makeThread({ text: question, origin: 'phone', worktree: false, ...speed });
    const { rec } = st;
    delete rec.explicitModel;
    const turnId = crypto.randomUUID();
    const sources = (params.sources ?? []).filter((x) => x?.url).slice(0, 10);
    const links = sources.map((x) => `- [${(x.title || x.url).replace(/[[\]]/g, '')}](${x.url})`).join('\n');
    const text = links ? `${answer}\n\n${links}` : answer;
    // In the order startTurn writes them: a user.message after turn.started
    // would read as one sent while the turn ran.
    this.emit(st, userMessage({ turnId, text: question, images: [], origin: 'phone' }), turnId);
    this.emit(st, { type: 'turn.started', turnId }, turnId);
    this.emit(st, { type: 'assistant.text', itemId: crypto.randomUUID(), text }, turnId);
    this.emit(st, { type: 'system.note', text: 'Answered by Ask from Agent Archive' }, turnId);
    for (const note of notes) this.emit(st, { type: 'system.note', text: note }, turnId);
    const askedAt = params.askedAt !== undefined && Number.isFinite(params.askedAt) ? params.askedAt : this.clock.now();
    const done = this.emit(st, { type: 'turn.completed', turnId, outcome: 'completed', durationMs: Math.max(0, this.clock.now() - askedAt), needs: 'nothing' }, turnId);
    rec.needs = { seq: done.seq, needs: 'nothing' };
    rec.preview = oneLine(answer, LIMITS.previewChars);
    rec.lastTurnCompletedSeq = done.seq;
    rec.lastSeenSeq = done.seq;
    // The answer came from a fast model, not a session of this thread's.
    rec.handoff = { fromCwd: rec.cwd, fromAccountId: rec.accountId, quickAsk: true };
    this.markDirty(st);
    void this.titleFromModel(st, question, answer);
    return { thread: this.summary(st) };
  },

  // The tour's sample threads (docs/protocol.md, threads.samples; samples.ts):
  // made up exchanges written as finished turns, like a quick ask, in the
  // folder the app gives (~/ThreadbearThreads/Welcome, where its example patch
  // is), so someone new has threads to hibernate, archive and look round.
  // Asking again makes them afresh; remove deletes them all, archived and
  // hibernating ones too.
  samples(this: Runner, params: { cwd: string; remove?: boolean }): { threads: ThreadSummary[] } {
    // Any there are go first, made fresh each time: ones left by a tour that
    // didn't finish could be hibernating, archived, in another folder, or
    // from a runner that didn't trust the patch yet (Tinker Desk, 30 Oct).
    for (const st of [...this.threads.values()].filter((st) => st.rec.sample)) this.delete(st.rec.id);
    if (params.remove) return { threads: [] };
    // The folder and its example patch, written here and trusted as written:
    // one changed since is someone's code, and waits like any other.
    const cwd = path.resolve(expandHome(params.cwd));
    const patchFile = path.join(cwd, '.threadbear', 'patches', 'welcome.ts');
    fs.mkdirSync(path.dirname(patchFile), { recursive: true });
    if (!fs.existsSync(patchFile)) fs.writeFileSync(patchFile, WELCOME_PATCH);
    if (fs.readFileSync(patchFile, 'utf8') === WELCOME_PATCH) this.trustAgentPatches([{ path: patchFile, sha256: crypto.createHash('sha256').update(WELCOME_PATCH).digest('hex'), base: null }], cwd);
    const made: ThreadSummary[] = [];
    // Oldest first, so the first in SAMPLE_THREADS is the newest in the list.
    for (const sample of [...SAMPLE_THREADS].reverse()) {
      const { st } = this.makeThread({ text: sample.question, cwd, title: sample.title, worktree: false });
      const { rec } = st;
      rec.sample = true;
      const turnId = crypto.randomUUID();
      this.emit(st, userMessage({ turnId, text: sample.question, images: [] }), turnId);
      this.emit(st, { type: 'turn.started', turnId }, turnId);
      this.emit(st, { type: 'assistant.text', itemId: crypto.randomUUID(), text: sample.answer }, turnId);
      const done = this.emit(st, {
        type: 'turn.completed', turnId, outcome: 'completed', durationMs: 4000, needs: sample.needs,
        ...(sample.asks ? { asks: sample.asks } : {}),
      }, turnId);
      rec.needs = { seq: done.seq, needs: sample.needs, ...(sample.asks ? { asks: sample.asks } : {}) };
      rec.preview = oneLine(sample.answer, LIMITS.previewChars);
      rec.lastTurnCompletedSeq = done.seq;
      // Unseen: Needs you, or the blue dot; the rest read.
      if (sample.needs === 'nothing' && !sample.unread) rec.lastSeenSeq = done.seq;
      this.markDirty(st);
      made.push(this.summary(st));
    }
    return { threads: made.reverse() };
  },

  // The record and state of a new thread, before anything is sent to it:
  // its folder, login, model and effort as create picks them.
  makeThread(this: Runner, params: {
    text: string;
    cwd?: string;
    accountId?: string;
    poolId?: string;
    provider?: Provider;
    onlyProvider?: Provider;
    model?: string;
    effort?: EffortLevel;
    permissionMode?: PermissionMode;
    title?: string;
    origin?: MessageOrigin;
    scheduleId?: string;
    worktree?: boolean;
    startedBy?: ThreadStartedBy;
    detached?: boolean;
    coordinatorHelperFor?: string;
    id?: string;
    // Trusted runner-only initial record. No RPC accepts this field.
    initial?: Pick<ThreadRecord, 'id'> & Partial<Pick<ThreadRecord, 'intake' | 'backlog' | 'highlights' | 'highlightsAt'>>;
  }, warmId?: string): { st: ThreadState; notes: string[]; loginNote?: string; spare?: Spare } {
    // A request waiting for model catalogs can try again with the warm CLI.
    const warm = warmId && this.spare?.id === warmId && !this.threads.has(warmId) ? this.spare : undefined;
    let draft;
    try {
      this.checkAccepting();
      draft = this.draftRecord(params, warm);
    } catch (e) {
      if (!(e instanceof ModelListsPending)) this.claimSpare(warm?.id)?.session.kill();
      throw e;
    }
    const spare = this.claimSpare(warm?.id);
    const { rec, account, poolId, notes, loginNote } = draft;
    try {
      this.store.create(rec);
    } catch (e) {
      spare?.session.kill();
      throw e;
    }
    const st: ThreadState = { rec, rt: newRuntime(this.clock.now()) };
    this.threads.set(rec.id, st);
    // What Mike picked last is what the next thread starts on, so a
    // schedule's own login or pool (a 9:00 standup's) doesn't move it.
    if (params.origin === 'schedule' || params.coordinatorHelperFor) {
      /* keep the last pick */
    } else if (!poolId) this.rememberAccount(account.id);
    else if (params.poolId !== undefined) this.rememberPool(poolId);
    return { st, notes, loginNote, spare };
  },

  // A new thread's record as create works it out, without making the
  // thread: makeThread's, and a CLI started ahead of one
  // (runner/warm-start.ts), under the ids given.
  draftRecord(this: Runner, params: {
    text: string;
    cwd?: string;
    accountId?: string;
    poolId?: string;
    provider?: Provider;
    onlyProvider?: Provider;
    model?: string;
    effort?: EffortLevel;
    permissionMode?: PermissionMode;
    title?: string;
    origin?: MessageOrigin;
    scheduleId?: string;
    worktree?: boolean;
    startedBy?: ThreadStartedBy;
    detached?: boolean;
    coordinatorHelperFor?: string;
    id?: string;
    // Trusted runner-only initial record. No RPC accepts this field.
    initial?: Pick<ThreadRecord, 'id'> & Partial<Pick<ThreadRecord, 'intake' | 'backlog' | 'highlights' | 'highlightsAt'>>;
  }, ids?: { id: string; sessionId: string }): { rec: ThreadRecord; account: Account; poolId?: string; notes: string[]; loginNote?: string } {
    // A box runs one thread (docs/virtual-runners.md, decision 1): only that
    // one, once, under its own id. Anything else asks the main Mac
    // (create_thread from a box files a request, as from any runner key).
    if (this.boxThread !== undefined) {
      if (params.id !== this.boxThread || this.threads.has(this.boxThread)) throw new RpcError(ErrorCode.badParams, "This runner is a box for one thread, so it can't start another here.");
    } else if (params.id !== undefined) throw new RpcError(ErrorCode.badParams, 'Only a box names the id of a new thread.');
    // New threads belong on the new release.
    if (this.draining) throw new RpcError(ErrorCode.busy, 'This runner is handing over to a new one; start the thread there.');
    // A blank folder means the default, not the runner's own folder.
    const cwd = path.resolve(expandHome(params.cwd?.trim() ? params.cwd.trim() : this.cfg.defaults.cwd));
    // An accountId pins the thread to that login. Otherwise a pool picks
    // the login (docs/protocol/settings.md, "Pools"), except on a dev runner whose
    // keepAccount pins new threads to its own account.
    let poolId: string | undefined;
    let accountId = params.accountId;
    if (accountId === undefined && (params.poolId !== undefined || !peekRunnerJson(this.cfg.home).defaults?.keepAccount)) {
      const picked = this.pickForNew({ poolId: params.poolId, cwd, model: params.model, provider: params.provider, onlyProvider: params.onlyProvider });
      if (picked) ({ poolId, accountId } = picked);
    }
    // A schedule pinned to a signed-out login runs this time on a pool
    // holding it (pools.ts, standInFor), saying so as a pool move would.
    let loginNote: string | undefined;
    if (params.origin === 'schedule' && accountId !== undefined && params.poolId === undefined) {
      const accounts = this.usableAccounts();
      const stand = standInFor(this.pools(), accounts, accountId, cwd);
      if (stand) {
        const title = (id: string) => accounts.find((a) => a.id === id)?.title ?? id;
        const ended = accounts.find((a) => a.id === accountId)?.planEnded;
        loginNote = `Moved to ${title(stand.accountId)}: ${title(accountId)}${ended ? "'s plan has ended" : ' is signed out'}.`;
        ({ poolId, accountId } = stand);
      }
    }
    accountId ??= this.defaultAccountId();
    const account = this.accounts.get(accountId);
    if (!account) throw new RpcError(ErrorCode.accountNotFound, `No account called ${accountId}`);
    this.checkProvider(account);
    if (account.provider === 'pi' && params.permissionMode === 'plan') throw new RpcError(ErrorCode.badParams, 'Plan first is not available for Pi threads.');
    if (params.model && account.models === undefined && account.provider !== 'claude' && account.provider !== 'codex') throw new ModelListsPending([account]);
    if (!isDirectory(cwd)) throw new RpcError(ErrorCode.badParams, `Folder not found: ${cwd}`);
    // A folder the old sandbox experiment shut threads in (config.ts).
    const retired = this.retiredSandbox(cwd);
    if (retired) throw new RpcError(ErrorCode.badParams, retired);
    const now = this.isoNow();
    const id = params.initial?.id ?? params.id ?? ids?.id ?? crypto.randomUUID();
    const rec: ThreadRecord = {
      id,
      title: params.title?.trim() ? cutSafely(params.title.trim(), 200) : titleFrom(params.text),
      titleSet: Boolean(params.title?.trim()),
      cwd,
      accountId,
      ...(poolId ? { poolId } : {}),
      provider: account.provider,
      // None named: runner.json's default (a new install's is auto), else full.
      permissionMode: params.permissionMode ?? this.cfg.defaults.permissionMode ?? 'full',
      status: 'idle',
      createdAt: now,
      updatedAt: now,
      lastActivityAt: now,
      preview: '',
      lastSeq: 0,
      lastSeenSeq: 0,
      nativeSessionId: ids?.sessionId ?? crypto.randomUUID(),
      sessionUsed: false,
      lastTurnCompletedSeq: 0,
      queue: [],
      pendingApprovals: [],
      ...params.initial,
      ...(params.coordinatorHelperFor ? { coordinatorHelperFor: params.coordinatorHelperFor } : {}),
    };
    const checked = this.checkSettings(account, params.model || this.defaultModelFor(account.provider), params.effort ?? this.defaultEffortFor(account.provider));
    if (checked.model) {
      rec.model = checked.model;
      if (params.model === checked.model) rec.explicitModel = explicitModelKind(account, checked.model);
    }
    if (checked.effort) rec.effort = checked.effort;
    // Whether the first turn should look for a worktree patch. Reading the
    // patch files is async, so it happens there; a folder with no patch
    // files at all (most of them) starts its CLI straight away as before.
    if (params.worktree !== false && this.mayWantWorktree(cwd)) rec.worktreePending = true;
    if (params.origin === 'schedule' && params.scheduleId) rec.schedule = { id: params.scheduleId, title: params.title?.trim() || rec.title };
    const startedBy = params.origin === 'schedule' && params.scheduleId ? { kind: 'schedule' as const, label: 'Schedule' } : params.startedBy;
    if (startedBy) {
      // Its title as it is now, for the row's tooltip: that thread may be
      // renamed, archived or deleted later.
      const from = startedBy.threadId ? this.threads.get(startedBy.threadId) : undefined;
      rec.startedBy = { ...startedBy, ...(from ? { threadTitle: from.rec.title } : {}) };
      // Only means something for a thread another thread started.
      if (params.detached && startedBy.kind === 'thread' && startedBy.threadId) rec.detached = true;
    }
    return { rec, account, ...(poolId ? { poolId } : {}), notes: checked.notes, loginNote };
  },

  // An account whose CLI this runner can't drive (a Codex login found
  // before the Codex adapter is wired) is refused up front, rather than
  // making a thread whose first turn can only fail.
  checkProvider(this: Runner, account: Account): void {
    if (!this.adapters[account.provider]) {
      throw new RpcError(ErrorCode.badParams, `This runner can't run ${providerName(account.provider)} threads yet, so ${account.id} can't be used.`);
    }
  },

  // Checks a model and effort against the account's provider (protocol,
  // "Models and effort across providers"). A model of the other provider,
  // or a Codex id the account doesn't list, gives way to the provider's
  // default; an effort the model doesn't offer is dropped. Each says so in
  // a note rather than failing the call, since an older app always sends a
  // model and can't get past an error.
  checkSettings(this: Runner, account: Account, model: string | undefined, effort: EffortLevel | undefined): { model?: string; effort?: EffortLevel; notes: string[] } {
    const notes: string[] = [];
    const provider = account.provider;
    if (model && !this.modelFits(account, model)) {
      const replacement = this.defaultModelFor(provider);
      const fallback = replacement && this.modelFits(account, replacement) ? replacement : undefined;
      const uses = fallback ? modelTitle(account, fallback) : account.defaultModel ? modelTitle(account, account.defaultModel) : "the account's default model";
      notes.push(`${model} isn't a ${providerName(provider)} model, so this thread uses ${uses}.`);
      model = fallback;
    }
    // No effort levels of ours on this provider (providers.ts).
    if (effort && providerInfo(provider).effort === 'none') effort = undefined;
    if (effort) {
      const row = modelRow(account, model ?? account.defaultModel);
      const noUltra = providerInfo(provider).effort === 'claude';
      const hasEffortList = Boolean(account.models?.some((m) => m.effortLevels?.length));
      const offered = (e: EffortLevel) => !(noUltra && e === 'ultra') && (row?.effortLevels ? row.effortLevels.includes(e) : !(row && hasEffortList));
      if (!offered(effort)) {
        const fallback = this.defaultEffortFor(provider);
        const next = fallback && fallback !== effort && offered(fallback) ? fallback : undefined;
        const why = noUltra && effort === 'ultra' ? `${effortTitle(effort)} effort is Codex only` : `${row ? row.title : 'This model'} doesn't offer ${effortTitle(effort)} effort`;
        notes.push(`${why}, so this thread uses ${next ? `${effortTitle(next)} effort` : "the model's own level"}.`);
        effort = next;
      }
    }
    return { ...(model ? { model } : {}), ...(effort ? { effort } : {}), notes };
  },

  // A loaded list is authoritative. A native id can be tried while its
  // list loads unless another provider already lists that id.
  modelFits(this: Runner, account: Account, model: string): boolean {
    if (modelRow(account, model)) return true;
    if (account.provider === 'pi') return model === account.connection?.model;
    if (account.models !== undefined) return false;
    return nativeModelProvider(model) === account.provider
      && !this.safeAccounts().some((a) => a.provider !== account.provider && modelRow(a, model));
  },
};

export type NewThreadsPart = RunnerPart<typeof newThreadsPart>;
