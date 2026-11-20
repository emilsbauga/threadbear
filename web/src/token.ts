// The browser's token: a browser token (convex/tokens.ts), kept in
// localStorage and sent with every query and mutation, exactly as the iPhone
// app's is.
//
// A sign-in link carries a one-use code in its #fragment (which a browser
// never sends to a server), not the token: the site trades the code for the
// token with tokens:claim and wipes it from the address bar. A link is
// copied, synced, kept in history and offered to other apps, and a token in
// one stayed good for its whole life (API 81). An old link's #token= is
// wiped and never kept, so one that's been seen can't sign anything in.
import { useSyncExternalStore } from 'react';

const KEY = 'threadbear.token';
const NOTE = 'threadbear.signInNote';
const listeners = new Set<() => void>();
// A sign-in code being traded, so the page says so rather than "not signed in".
let claiming = false;

/** What a sign-in link's fragment holds: a code to trade, an old token link, or nothing. */
export function readSignInHash(hash: string): { code?: string; oldLink: boolean } {
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  const code = params.get('code') ?? undefined;
  return { code: code && /^tbp_[0-9a-f]{16,128}$/.test(code) ? code : undefined, oldLink: params.has('token') };
}

/**
 * Reads the sign-in code (if any) from the address bar and wipes the
 * fragment, before anything renders. An old token link is wiped too, with a
 * note to say so.
 */
export function takeSignInCodeFromHash(): string | undefined {
  if (!location.hash) return undefined;
  const { code, oldLink } = readSignInHash(location.hash);
  if (!code && !oldLink && !/[#&](code)=/.test(location.hash)) return undefined;
  history.replaceState(null, '', location.pathname + location.search);
  if (oldLink && !code) setNote('That sign-in link is from an older Threadbear. Update Threadbear on your Mac, then open the website signed in again.');
  else if (!code) setNote('That sign-in link isn’t one Threadbear can use.');
  return code;
}

// A sign-in link opened in a browser that's already signed in: held here,
// in memory only, until you say whether to swap (ReplaceSignIn). A thread's
// words can link to this site with a #code= of their own, and one click
// mustn't quietly sign this browser in as someone else's, or out of yours
// (Daybreak finding 145, 16 Nov 2026). Nothing is claimed or kept first.
type Claim = (code: string) => Promise<{ token: string }>;
let pending: { code: string; claim: Claim; refused: (e: unknown) => boolean; failed?: string } | undefined;

/**
 * Starts a sign-in link's sign-in: straight away in a browser that isn't
 * signed in, and only once you say so in one that is.
 */
export function startSignIn(claim: Claim, code: string, refused: (e: unknown) => boolean): void {
  if (localStorage.getItem(KEY)) {
    pending = { code, claim, refused };
    listeners.forEach((l) => l());
    return;
  }
  void claimSignIn(claim, code, refused);
}

/** The sign-in link waiting for a yes, if any, and why its claim failed. */
export function usePendingSignIn(): { failed?: string } | undefined {
  return useSyncExternalStore(subscribe, () => (pending ? pendingView(pending) : undefined));
}

// A stable object per state, as useSyncExternalStore compares snapshots.
let lastView: { from: typeof pending; failed?: string; view: { failed?: string } } | undefined;
function pendingView(p: NonNullable<typeof pending>): { failed?: string } {
  if (lastView?.from !== p || lastView.failed !== p.failed) lastView = { from: p, failed: p.failed, view: p.failed ? { failed: p.failed } : {} };
  return lastView.view;
}

/** Your answer to a held sign-in link: swap this browser's sign-in for it, or not. */
export async function answerPendingSignIn(swap: boolean): Promise<void> {
  const p = pending;
  // Nothing waiting, or a press while a claim is going (the buttons are
  // disabled then, but a key repeat can still get here).
  if (!p || claiming) return;
  if (!swap) {
    pending = undefined;
    listeners.forEach((l) => l());
    return;
  }
  claiming = true;
  listeners.forEach((l) => l());
  try {
    const { token } = await p.claim(p.code);
    localStorage.setItem(KEY, token);
    pending = undefined;
  } catch (e) {
    // A second press while the first was claiming: the first has settled it.
    if (pending !== p) return;
    // The browser's own sign-in is untouched; the code's gone either way.
    pending = { ...p, failed: p.refused(e) ? 'That sign-in link has expired or was already used. This browser is still signed in as before.' : 'Threadbear couldn’t be reached. This browser is still signed in as before.' };
  }
  claiming = false;
  listeners.forEach((l) => l());
}

/** Trades the code for this browser's token (tokens:claim), and keeps it. */
export async function claimSignIn(claim: (code: string) => Promise<{ token: string }>, code: string, refused: (e: unknown) => boolean): Promise<void> {
  claiming = true;
  listeners.forEach((l) => l());
  try {
    const { token } = await claim(code);
    localStorage.setItem(KEY, token);
    setNote(undefined);
  } catch (e) {
    // The backend saying no (used, expired) is different from not reaching it.
    setNote(refused(e) ? 'That sign-in link has expired or was already used. On the Mac, open the website signed in again.' : 'Threadbear couldn’t be reached to sign this browser in. Check the connection, then on the Mac open the website signed in again.');
  }
  claiming = false;
  listeners.forEach((l) => l());
}

function setNote(note: string | undefined): void {
  if (note) sessionStorage.setItem(NOTE, note);
  else sessionStorage.removeItem(NOTE);
  listeners.forEach((l) => l());
}

/** Why the last sign-in link didn't sign in, for the sign-in page. */
export function useSignInNote(): string | null {
  return useSyncExternalStore(subscribe, () => sessionStorage.getItem(NOTE));
}

/** A sign-in link's code is being traded right now. */
export function useSigningIn(): boolean {
  return useSyncExternalStore(subscribe, () => claiming);
}

export function signOut(): void {
  localStorage.removeItem(KEY);
  sessionStorage.removeItem(NOTE);
  listeners.forEach((l) => l());
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  window.addEventListener('storage', l);
  return () => {
    listeners.delete(l);
    window.removeEventListener('storage', l);
  };
}

export function useToken(): string | null {
  return useSyncExternalStore(subscribe, () => localStorage.getItem(KEY));
}
