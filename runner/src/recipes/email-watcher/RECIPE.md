---
name: Email watcher
icon: ✉️
description: New emails wake the threads waiting on them, reach the threads they're about, or wait for you on a twice-daily list.
by: Mike
when: Every few minutes
color: #3f63c4
experiment: mailWatch
---

## About

Agents often wait on an email: a reply from someone, an approval, a delivery, a
code. Without this, a thread waiting on one sits there until you notice the
email yourself and go and tell it.

Every few minutes the runner reads your new emails and a small model sorts them
against your threads. One a hibernating thread was waiting on wakes it with the
email. One about an open thread's work is kept for that thread's next turn.
Anything else that looks like it needs you goes on a list that comes twice a
day. Newsletters, receipts and notifications are left alone.

It's Threadbear's Email watcher experiment, so this switch is that one. It came
from Mike's own setup in November 2026.

## Example

**Your emails, 4 pm**

3 emails that look like they need you:
- **Sam Lee**, "Contract changes": wants a yes on the new dates by Monday.
  Suggested: reply that Monday works.
- **Landlord**, "Inspection": asks which morning next week suits.
- **GitHub**, "Your token expires in 7 days": renew it, or the release job
  stops.

Since the last list: woke "Wait for the refund" (the refund came), and kept an
email for "Book the venue".

## Setting it up

The runner holds no mail login. It runs a command of the user's that prints
their new emails, so this setup is mostly making that command.

1. Ask the user where their email is (Gmail, iCloud, Fastmail, a work account)
   and how often to look (default every 5 minutes), and whether they want the
   twice-daily list and at what times (default 9:00 and 16:00).
2. Write the command in this folder: a small script that prints a JSON list of
   new emails, each with `id`, `from`, `subject` and the start of its `text`
   (and optionally `date`, `url`, `account`). It gets `THREADBEAR_MAIL_STATE`,
   a file where it keeps its place. For IMAP, read the password from the macOS
   Keychain (`security find-generic-password -w`) and have the user add it
   there themselves (an app password for Gmail and iCloud); never put a
   password in the script or a file. Run it once and show the user what it
   prints.
3. Put the settings under `mailWatch` in the runner's `runner.json` (in its
   data folder): `command` (the script's full path), and `everyMinutes`,
   `digestAt` if they changed them. Leave `decisions` out, so it never acts
   on an email by itself; tell the user it can, if they name files of standing
   decisions.
4. Tell them it's on, and that the sender, subject and first 1,500 characters
   of each new email go to a small model to be sorted.
