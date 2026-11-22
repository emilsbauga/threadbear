# The reply and the Needs you card, take 3 (1 Nov 2026)

Mike, 1 Nov, with two cards side by side:

- In thread 77e7a0a6, the summary bullets replaced the agent's message,
  so the Decision needed card tried to carry all the context and became
  a wall of text.
- In thread 6fb15afc (Bruce's Full Disk Access), the message did show,
  and the card repeated about half of it, then stopped mid-word.

"I want to get to the bottom of why it's doing this… so we don't have
duplicated context, so we're not wasting the agent's tokens, we're not
confusing the model, but we're still getting to the point for the user
faster so they can make a decision with just the right amount of
context." He wants it right before other people start using it next week.

## Why it happens

1. **The agent is told to write the same context three times.** The
   end_turn description (about 1,160 words) asks for:
   - a message "at the length it deserves",
   - summary bullets that "stand alone" and "never point at something
     above",
   - asks that "make sense on [their] own to someone who has forgotten
     everything".

   Doing all of that produces the Bruce card.
2. **It can't know which one Mike will see.** The Mac app chooses the
   message or the bullets after the turn, by length, and a narration
   block never wins (`TranscriptReducer.reply(of:)`). The phone,
   notifications and Highlights each show something else. The card is
   the only text the agent can count on being next to the question, so
   the safe move is to put everything in it.
3. **Opus 5.5 sometimes sends its message as narration.** That's a
   thinking block signed as narration, so only the API's paraphrase
   reaches the runner (`normalize.ts`, `isNarration`). The first reply
   in 77e7a0a6 arrived as one sentence. end_turn answered with
   BULLETS_ONLY ("Stop here, with no more text: the user has your
   bullets"), so the agent stopped, the full message was never asked for
   again, and the card was left to carry everything. Every progress note
   in that thread was paraphrased the same way. The fixes for lost
   replies (NO_REPLY, NARRATION_ONLY, owed replies) work by getting the
   agent to write it again, which spends more tokens and repeats more
   text. Or, as here, they tell it to stop, and the words are gone.
4. **No budget, then a silent cut.** The agent is only told "a sentence
   or two". The runner cuts `why` at 500 characters without saying so
   (`needs.ts`, `str()`), which is how the Bruce card ended at
   "though you m".

Text inside a tool call is never paraphrased, which is why the 29 Oct
eval found summaries in end_turn reliable when final messages weren't.

## What 1,507 real turns show (28 Oct to 1 Nov)

The survey is in `~/dev/me/misc/endturn-study`; `run.sh <since>` reruns
it. The data covers 340 threads and 1,507 turns that ended with
end_turn: 746 needed Mike, with 990 asks between them, and 73% of those
turns had a single ask.

- **What decides the reply is mechanics, not content.**
  - With bullet replies on, the bullets showed in 64% of the turns with
    asks.
  - 69 of those had no words after the last tool call, 48 had only
    narration there, and 21 had a sign-off shorter than the bullets.
  - In 38% of turns with bullets, every word after the last tool call
    was narration, so the agent's own wording never reached Threadbear.
- **The why either repeats or makes up.**
  - When the message showed, 70% of whys mostly repeated it.
  - When the bullets showed, 72% of whys shared nothing with them: they
    carried the context the bullets left out.
  - Both rates are floors, as paraphrases slip past the check.
- **Cards grew to fill the gap.** Median why 200 characters, p90 351,
  and 7 cut at 500. Median card paragraph 272, p90 440. Messages that
  won were a median 1,485.
- **Asks pointing at things Mike never saw.**
  - 6f706f43 asked about an email's wording, but the email was only in
    narration.
  - 669bf3d0 offered names ("webdrive", "chromey") from a list that was
    only in narration.
  - In 3a05f958, a message arriving mid-turn reset the reply, and the
    What's New text Mike was meant to check folded away.

## What five days of fixes say

36 commits between 27 Oct and 1 Nov changed how a turn ends. About ten
of them keep going back and forth on one question: is the reply the
agent's own message or what it puts in end_turn?
- `d21c763` (29 Oct) made the end_turn bullets the reply, because they
  arrive reliably.
- `fc31b96`, `472dbfa`, `bf92501`, `5aaa36c`, `16509f4` and `697e610`
  each brought the message back with a rule: whichever is longer,
  narration never wins, text after end_turn counts in some cases, and
  the Bullet replies setting.
- Leaning on the bullets lost answers (the Sentry report, the Qantas
  details). Leaning on the message hit model quirks (narration, answers
  left in thinking, repeats).

The card churn is the same problem from the other side. Context moved
into the card, so the card needed paging and collapsing, and the reply
between them got thinner.

Other places have drifted too:
- The phone has its own older copy of the reply rule.
- Its push notification shows the bullets, never the question.
- Codex works in the opposite order (end_turn, then its answer), so
  every reply rule needs a Codex exception.

On the two real cards, `~/dev/me/misc/end-turn-eval/v3/overlap.mjs`
finds 37% of the Bruce card's words and 24% of the Walkies card's words
repeating the reply above them. That's a floor: it misses paraphrases.
The Walkies turn (f6ffb3a1, 31 Oct 12:30) also wrote its report three
times: a message that reached the runner as a one-line narration, the
bullets, and then the whole message again after end_turn. The card then
repeated part of it a fourth time.

## Options (rendered with `python3 build.py && ./render.sh`)

Each one shows the same two real turns: the Walkies deploy decision on
top and Bruce's Full Disk Access step below. `0-today` marks what's
repeated now.

1. `1-reply-explains` **A. The reply explains, the card asks.**
   - The agent writes one reply, inside end_turn, so narration can't
     paraphrase it. It's the reply on the Mac and the phone; the bullets
     go.
   - The card is the question, plus a one-line "what happens" note under
     each answer. There's no why paragraph.
   - Previews and notifications use a headline line.
   - See `end-turn-A.md`.
2. `2-card-decides` **B. Bullets report, the card holds the decision.**
   - The bullets stay as the reply, with a message only when Mike asked
     for something to read, and neither says anything about the ask.
   - The card stands on its own: up to two sentences of context, the
     question, and answers with notes.
   - Closest to today. See `end-turn-B.md`.
3. `3-brief-first` **C. Brief first, the full reply one click away.**
   This is the Codex desktop shape.
   - The same end_turn as A, plus 3 to 5 bullets.
   - The bullets show first, with "Full reply ›" right under them,
     never folded into the working.
   - The card is the same as A's.
   - A and C are the same underneath, so one can be the default and the
     other the Bullet replies setting. Unlike today, neither loses the
     answer.

A "why behind an ⓘ" option was drawn and dropped. On 1 Nov Mike turned
down a quieter or capped why, and on 28 Oct he turned down a question
with its reason in small grey text.

### What Mike has said that shaped these

From the archive, 25 Oct to 1 Nov:
- Read the least, but keep what's needed to decide, at normal size,
  where he decides.
- Never hide the answer: "Where is it? I don't see it" is his most
  repeated complaint.
- Codex desktop is the model: the briefest summary, a clear next step,
  and the working behind an expander.
- Free text next to every set of options.
- Nothing sends on one click.

On 28 Oct he asked for the card to carry the agent's own ask text
("can it not just use that same text"). That was while looking at a
turn whose reply had been lost, so only the card showed. Each step
since (that card, then the bullets) moved context into the card because
the reply was unreliable. A and C make the reply reliable instead.

**Pick: A.** One reply, written once, can't be lost, with nothing
repeated in the card. end_turn's instructions drop from about 1,160
words to 300, and most of the rules in `reply(of:)`, NO_REPLY,
NARRATION_ONLY, BULLETS_ONLY and owed replies can go. C stays available
as the Bullet replies view. B is the real alternative and the best fit
for the phone. But it relies on agents keeping their explanation out of
their message and putting it in the card, the opposite of how they
write now: 70% of whys under a message that showed repeat it.

## Checking the pick before it ships

1. **Replay eval** (about 60 real sessions, roughly $10, on the October
   rig in `~/dev/me/misc/end-turn-eval`, with a v3 stand-in end_turn per
   option):
   - Four tasks: a decision (a deploy that needs Mike's OK), a step for
     Mike (a missing API key), a question answered with an explanation,
     and a plain done.
   - Today's wording plus A, B and C, each on Opus 5.5 twice and on
     Sonnet 5.5, Haiku 5.5 and Codex once.
   - Measured on every run: how much of the card repeats the reply
     (`v3/overlap.mjs`), card length, whether the reply arrived whole
     (no narration), whether every answer has a note, and output tokens
     and cost.
   - Each run's ending is drawn with this folder's mockup style, so Mike
     can look through real results side by side in a review window.
2. **Live trial**: the pick goes behind a setting on Mike's runner (as
   Bullet replies did) for a day of real threads. Then the real-data
   survey is rerun, before against after.
3. Then the pick becomes the default for next week's release, and the
   rules it replaces come out.

## What Mike picked, and the eval (1 Nov 2026)

Mike picked A: "try your pick… run an eval, and then if it passes… I'll
try it out for a little bit." The eval lives in
`~/dev/me/misc/end-turn-eval/v3`. `harness.mjs` runs a real session the
way the runner does: the Agent SDK, Claude Code's prompt with Threadbear's
lines, adaptive thinking shown summarised (which is what produces
narration), and a stand-in threadbear server. There are four tasks:
- a fix that ends done (`slug`)
- a missing key (`key`)
- explain, then decide (`bundle`)
- a deploy decision (`deploy`)

Each task ran on Opus 5.5 at medium and high, Sonnet 5.5 and Haiku 5.5:
64 sessions in all (two rounds), about $7.40. `grade.mjs` says what the Mac app would
have shown.

| per 16 runs | today | A1: reply inside end_turn | A2: end_turn, then the reply |
|---|---|---|---|
| agent's own words lost | 6 (all Opus) | 0 | 0 |
| needs right | 13 | 11 | 14 |
| reply written twice | (6 rewrote it after end_turn) | 9 | 2 |
| "What I need from you" in the reply | - | 4 | 1 |
| output tokens, median | 2,343 | 2,191 | 1,667 |
| card characters, median | 259 | 188 | 205 |

A1 kept the reply safe but models wrote it out a second time after
end_turn: they want to end on a message. Narration never came after the
last tool call in any of the 32 sessions checked, while 10 narration
blocks came before one. So A2 puts the reply where models already write
it: end_turn first (the card and a headline), then the message. Codex
already worked this way.

On screen it's the same as A. The remaining misses:
- Sonnet once wrote a bare "What I need from you:" section into its
  reply. The runner now turns such a section into the card
  (`splitReplySection`).
- Opus once asked a sensible extra question (redirect the old URLs?).
- The notes under answers share words with the reply ("I run the deploy
  and check it went out"). Today's cards repeated whole sentences of
  context instead.

Built behind Settings > General > One reply (`oneReply`), off by default,
for Mike to try (docs/protocol/needs-you.md, "One reply").

Regression cases for the trial, real threads where the reply went wrong:
- 77e7a0a6, this one: the reply came as narration.
- 6fb15afc: the card repeated the message.
- f6ffb3a1: the Walkies deploy.
- The "4K Video Downloader" thread: "Explained the two follow-ups" over
  an explanation that never showed.
- 6f706f43 and 669bf3d0: asks about things only in narration.
- 3a05f958: a reply reset by a message arriving mid-turn.
