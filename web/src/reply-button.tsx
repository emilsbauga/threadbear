// A reply button on Mike's own thread page (reply-buttons.ts). A shared page
// never draws one: its links are just their titles (messages.tsx).
import { type ReactNode } from 'react';
import { useMutation } from 'convex/react';
import { api } from '../../convex/_generated/api';
import { go } from './route';
import * as Icon from './icons';
import { buttonLook, type MessageButton } from './reply-buttons';
import { CommandNote, useCommand } from './command-state';

export function ReplyButton({ token, threadId, button, title, threadPath }: { token: string; threadId: string; button: MessageButton; title: ReactNode; threadPath: (id: string) => string }) {
  const press = useMutation(api.phone.press);
  // Stays done, so the button stays Pressed with its thread to open.
  const cmd = useCommand(token, { keepDone: true });
  const look = buttonLook(button, cmd.state);
  const onClick = () => {
    if (look.kind === 'pressed') {
      if (look.threadId) go(threadPath(look.threadId));
      return;
    }
    void cmd.run(() => press({ token, threadId, buttonId: button.id }), undefined);
  };
  return (
    <span className="reply-button-wrap">
      <button className={`reply-button rb-${button.kind} rb-${look.kind}`} disabled={look.kind === 'pressed' ? !look.threadId : cmd.busy} title={look.tip} onClick={onClick}>
        {look.kind === 'pressing' ? <span className="spinner" /> : look.kind === 'pressed' ? <Icon.Check /> : null}
        {/* The title the runner keeps, not the link's words: an agent can't
            label a button one thing and have it do another (Codex's review). */}
        <span>{button.title || title}</span>
      </button>
      {look.kind === 'failed' ? <span className="reply-button-error">{look.error}</span> : look.kind === 'slow' ? <CommandNote command={cmd} className="inline" /> : null}
    </span>
  );
}
