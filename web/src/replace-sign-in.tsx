// A sign-in link opened in a browser that's already signed in (token.ts,
// startSignIn): nothing changes until you say to swap, so a link in a
// thread's words can't quietly sign this browser out or in as another.
import { useSigningIn, usePendingSignIn, answerPendingSignIn } from './token';

export function ReplaceSignIn() {
  const pending = usePendingSignIn();
  const busy = useSigningIn();
  if (!pending) return null;
  return (
    <div className="confirm-back">
      <div className="confirm" role="dialog" aria-modal="true" aria-labelledby="replace-sign-in-title">
        <h2 id="replace-sign-in-title">{pending.failed ? 'Not signed in again' : 'Sign this browser in again?'}</h2>
        {pending.failed ? (
          <p>{pending.failed}</p>
        ) : (
          <p className="muted">This browser is already signed in. Only sign in again if you just chose Open signed in on your Mac. If a link in a thread brought you here, keep this one.</p>
        )}
        <div className="confirm-buttons">
          {pending.failed ? (
            <button className="btn primary" title="Close this" onClick={() => void answerPendingSignIn(false)}>
              OK
            </button>
          ) : (
            <>
              <button className="btn" disabled={busy} title="Stay signed in as you are" onClick={() => void answerPendingSignIn(false)}>
                Keep this sign-in
              </button>
              <button className="btn primary" disabled={busy} title="Swap this browser's sign-in for the one in the link" onClick={() => void answerPendingSignIn(true)}>
                {busy ? <span className="spinner" /> : null}
                Sign in again
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
