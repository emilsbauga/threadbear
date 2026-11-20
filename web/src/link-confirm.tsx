// Links drawn from a thread, through link-policy.ts: a web page is a plain
// link, another app's link asks first (LinkConfirm, mounted once in
// main.tsx), and anything else is only its words.
import { useEffect, useRef, useSyncExternalStore, type ReactNode } from 'react';
import { classifyLink } from './link-policy';

let asking: { url: string; scheme: string } | undefined;
const listeners = new Set<() => void>();
const changed = () => listeners.forEach((l) => l());

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** Opens a link from a thread, one another app takes after asking. */
export function OutLink({ href, className, title, children }: { href: string; className?: string; title?: string; children: ReactNode }) {
  const target = classifyLink(href, location.href);
  if (target.kind === 'web') {
    return (
      <a className={className} href={target.url} target="_blank" rel="noreferrer" title={title}>
        {children}
      </a>
    );
  }
  if (target.kind === 'never') {
    return (
      <span className={className ? `${className} inert-link` : 'inert-link'} title="Threadbear doesn't open this kind of link">
        {children}
      </span>
    );
  }
  // No href: a middle click or "open in new tab" would hand the address
  // straight to the browser, past the question.
  const ask = () => {
    asking = { url: target.url, scheme: target.scheme };
    changed();
  };
  return (
    <a
      className={className ? `${className} app-link` : 'app-link'}
      role="button"
      tabIndex={0}
      title={title ?? `Opens another app (${target.scheme}:), after asking`}
      onClick={(e) => {
        e.preventDefault();
        ask();
      }}
      onKeyDown={(e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        ask();
      }}
    >
      {children}
    </a>
  );
}

function close() {
  asking = undefined;
  changed();
}

/** The question before another app's link opens. Mounted once, over everything. */
export function LinkConfirm() {
  const open = useSyncExternalStore(subscribe, () => asking);
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    cancel.current?.focus();
    const key = (e: KeyboardEvent) => e.key === 'Escape' && close();
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [open]);
  if (!open) return null;
  const go = () => {
    // Read again as it opens: only an address the rule still says asks.
    const target = classifyLink(open.url, location.href);
    close();
    if (target.kind !== 'ask' || target.url !== open.url) return;
    const a = document.createElement('a');
    a.href = target.url;
    a.target = '_blank';
    a.rel = 'noreferrer';
    a.click();
  };
  return (
    <div className="confirm-back" onClick={close}>
      <div className="confirm" role="dialog" aria-modal="true" aria-labelledby="link-confirm-title" onClick={(e) => e.stopPropagation()}>
        <h2 id="link-confirm-title">Open this in another app?</h2>
        <p className="muted">This link isn't a web page. Your browser hands all of it to whichever app takes {open.scheme}: links.</p>
        <code className="confirm-url">{open.url}</code>
        <div className="confirm-buttons">
          <button ref={cancel} className="btn" title="Don't open it" onClick={close}>
            Cancel
          </button>
          <button className="btn primary" title={`Hand this ${open.scheme}: link to its app`} onClick={go}>
            Open
          </button>
        </div>
      </div>
    </div>
  );
}
