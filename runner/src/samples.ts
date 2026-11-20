// The tour's sample threads (docs/protocol.md, `threads.samples`): made up
// exchanges, written as finished turns with no CLI, so someone new has
// threads to hibernate, archive and look round before they've run any of
// their own (Mike, 29 Oct 2026). The app removes them when the tour ends.
import type { Ask } from './protocol.ts';

export type SampleThread = {
  title: string;
  question: string;
  answer: string;
  // 'you' with asks: the thread shows as Needs you, with its card.
  needs: 'you' | 'nothing';
  asks?: Ask[];
  // Left unread, so the list has a blue dot to explain.
  unread?: boolean;
};

// In the inbox's order, newest first: the first is the one the tour opens
// for Highlights and the example patch's chip, so it carries a link.
export const SAMPLE_THREADS: SampleThread[] = [
  {
    title: 'Fix the flaky login test',
    question: 'The login test fails about one run in ten. Can you find out why?',
    answer:
      "Found it. The test clicks **Sign in** before the form has finished loading, so now and then the click lands on nothing. I made it wait for the form first, then ran it 50 times without a failure.\n\n" +
      "Playwright's notes on waiting for elements explain the pattern: https://playwright.dev/docs/actionability",
    needs: 'you',
    asks: [
      {
        action: 'Should I make the other form tests wait the same way?',
        why: 'Three more tests click before their forms load. It would be the same one-line change in each.',
        options: ['Yes', 'Not now'],
        // What each answer does, as end_turn's asks always carry, so the
        // sample card draws its answers as rows with the Recommended star
        // like a real one; bare options drew an older look of buttons (Mike
        // spotted it on the Dell, 17 Nov).
        optionNotes: ['I change the three tests and run each 50 times', 'I leave them as they are'],
        suggested: 0,
      },
    ],
  },
  {
    title: 'Plan the weekend',
    question: "Make me a plan for Saturday: the hardware shop, a bike ride if it's dry, and dinner at Mum's at six.",
    answer:
      "Here's Saturday:\n\n" +
      "- **9:00** Hardware shop, before it gets busy\n" +
      "- **10:30** Bike ride, about 90 minutes, if the rain holds off\n" +
      '- **5:15** Leave for dinner at your mum\'s, there by six\n\n' +
      "If it's wet, swap the ride for the afternoon and keep the rest.",
    needs: 'nothing',
    unread: true,
  },
  {
    title: 'Draft the release notes',
    question: 'Write short release notes for version 1.2 from the changes since 1.1.',
    answer:
      '**Version 1.2**\n\n' +
      '- Search now finds threads by their messages, not only their titles.\n' +
      '- The app starts faster on a big inbox.\n' +
      "- Fixed images that didn't show after a restart.",
    needs: 'nothing',
  },
];

// The example patch the samples' folder gets (the tour's Roll a die). The
// runner writes it and trusts that exact text (patch-trust.ts), so its chip
// shows straight away; the app writing it left it waiting as untrusted
// (Mike on Tinker Desk, 30 Oct). Its comment is for whoever opens the file.
export const WELCOME_PATCH = `// A patch: tools for the threads in this folder. This one adds a chip
// above the composer that runs a command. A patch can also add panels
// beside a thread and checks that run after each turn. You don't have
// to write them: ask a thread to "add a button that runs the tests" and
// its agent writes one like this.
export default {
  icon: "dice",
  actions: [
    { title: "Roll a die", run: "echo \\"You rolled a $(( RANDOM % 6 + 1 )).\\"" },
  ],
}
`;
