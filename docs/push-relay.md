# The push relay

The one shared piece of Threadbear. Built 28 Oct 2026 (thread 66935d23);
the decisions are in docs/setup-and-updates.md section 2.4.

## Why it exists

Apple only delivers a notification to the App Store app if it's signed with
the key of the developer account that published it: Mike's. That key also
signs for his other apps, so it can't go into other people's Threadbear
backends. The relay is a small Convex project of Mike's that holds the key
and forwards notifications for them. Everything else in Threadbear runs on
each person's own Mac and their own Convex deployment.

## What it sees, and what it keeps

- **Sees:** a device token, whether it's a development or App Store install,
  a thread id (a random UUID), and the notification **sealed** with a key
  only that phone and its own backend have. It never sees the title or text.
- **Keeps:** one row per Threadbear install (a random id, the hash of its
  key, when it was made and last seen, the version it says it is, and for
  backends from 5 Nov 2026 the address of the Convex deployment it
  registered for) and daily totals (notifications sent and failed, why
  the failed ones failed as Apple's status and reason word, new
  installs). No device tokens, no thread ids, nothing per notification.
  An install nobody has used for 90 days loses its key (a daily cron,
  `relay:expire`); its backend registers again by itself, as the same
  install, if it ever sends another. The keyless row (just the deployment
  and dates) goes a year after that (since 16 Nov 2026).
- **Opting out:** `npx convex env set PUSH_RELAY off` on your deployment. Then
  nothing goes to the relay, and the phone gets no notifications (they'd have
  to come from somewhere). Mike can forget an install:
  `npx convex run relay:forget '{"installId":"i_..."}' --prod` in `relay/`.

## How a notification travels

1. The phone makes 32 random bytes the first time (`PushKeyStore`, in the
   keychain under an App Group its notification extension shares) and sends them to its
   own backend with `phone:registerDevice` (API 4), never anywhere else.
2. When a thread needs Mike, `convex/push.ts` seals `{title, body}` with that
   phone's key (AES-256-GCM: nonce, ciphertext, tag, base64) and posts it to
   the relay's `/send` with the backend's install id and key (registered once
   through `/register` and kept in the `relayRegistrations` table; see
   "Registering" below). Each registration gives the install a new key and
   kills the old one, so one send registers at a time and the others wait
   for its key; a send whose key the relay refuses (401) registers again and
   sends that push once more (`convex/relayInstallMachine.ts`).
3. The relay sends Apple a stand-in ("Threadbear: A thread needs you") with
   `mutable-content` and the sealed text in `e`.
4. The app's notification extension (`ios/NotificationService`) opens `e`
   with the key and shows the real title and text. If it can't, the stand-in
   shows.

A backend with its own Apple key (`APNS_*` env: Mike's) sends directly and
skips the relay. `PUSH_VIA=relay` sends through the relay anyway, for testing.

### UnifiedPush: the F-Droid build, with no relay

The Android app's F-Droid build (`android-native/`, flavour `fdroid`) has no
Firebase, so it doesn't use the relay at all (API 93, 19 Nov 2026):

1. The phone asks its own backend for the deployment's VAPID public key
   (`phone:webPushKey`, made once and kept in the `webPushVapid` table), then
   registers with the UnifiedPush distributor app on the phone (ntfy and the
   like), which gives it an https endpoint on the distributor's server and
   Web Push keys. It registers those with `phone:registerDevice`,
   `platform: "webpush"`, the endpoint as `apnsToken` and the keys as
   `webPush`, plus its 32-byte push key as before.
2. `convex/push.ts` (`sendWebPush`) posts each notification to that endpoint
   itself: `{ threadId, e }` (the same sealed title and text as Firebase's),
   encrypted for the phone with RFC 8291 (at most 3993 bytes, so the whole
   body fits in 4096, which the phone's connector requires) and signed with the VAPID key (RFC
   8292), both in `convex/webPush.ts` with node:crypto, checked against the
   RFC's own example in `runner/test/unit/web-push.test.ts`. The
   distributor's server sees the endpoint and an opaque blob; it can't read
   the thread id either. `PUSH_RELAY=off` doesn't stop these, as no relay is
   involved.
3. The endpoint is chosen by whoever holds the phone's pairing token, so the
   backend only takes a public https one (`convex/webPushEndpoint.ts`: for
   IPv6 only global unicast, less 6to4, Teredo and documentation). Each post
   goes over node:https with a `lookup` (`pinnedLookup` in `webPush.ts`) that
   refuses a name if any address it resolves to is private, in the same
   lookup the socket connects with, so a name can't answer differently
   between a check and the connection. It never follows a redirect, reads at
   most 256 bytes of an error, and gives up after 10 seconds, lookup
   included. Web pushes go out side by side with each other and with
   Apple's and Firebase's, so a slow server holds up nobody. A 404 or 410
   means the distributor dropped the phone, and keys that aren't a P-256
   point can never work, so either way the row goes. Names are looked up
   through c-ares (`Resolver`), not the system's getaddrinfo, so stalled DNS
   can't tie up the worker threads Apple's and the relay's lookups need.
4. Known gap: `pushOff` (`pushHealth.ts`) and the health line's `via` still
   only know Apple and the relay. A backend with `PUSH_RELAY=off` and no
   Apple key says push is off even though UnifiedPush works, and a failing
   web push shows as the relay's. The F-Droid app ignores `pushOff` for that
   reason; Mike's own setup always has the relay.

### An Android phone

The same, through Firebase Cloud Messaging (API 66):

1. The Android app makes its 32 bytes (kept wrapped by an Android Keystore key)
   and registers them, with its Firebase token as `apnsToken` and
   `platform: "android"`, with `phone:registerDevice`.
2. `convex/push.ts` seals the same `{title, body}` and posts it to the relay's
   `/send` with `platform: "android"`, the Firebase token as `deviceToken` and
   no environment. This goes through the relay even for a backend with its own
   Apple key, which is no use to Android.
3. The relay (`relay/convex/fcm.ts`) sends Firebase a data-only message,
   `{ threadId, e }`, at high priority with an hour to live. It holds the service
   account key (`FCM_SERVICE_ACCOUNT`) of the Firebase project the app was built
   for, which is whoever publishes the app's. It sees the token and the thread
   id, and the sealed text it cannot open. A second app built against its own
   Firebase project has its key in `FCM_SERVICE_ACCOUNT_2`: Mike's relay holds
   Keith's (his `platima/threadbear` Android app) in the first and Mike's
   native app's (`android-native/`, project `threadbear-android`) in the
   second, since 11 Nov 2026. A token only works with its own project, and the
   relay keeps no tokens, so a send tries each key in turn until one sends it
   or the token's own project gives a verdict on it (`fcmSettled`, `fcmPick`
   in `fcmMessage.ts`): another project's token is a `SENDER_ID_MISMATCH`, so
   a 404 UNREGISTERED still drops the phone, and a key failing on its own
   (401, a timeout) just moves on to the next. Unpairing the app deletes its
   Firebase token, so the backend's next send drops the phone.
4. The Android app's `FirebaseMessagingService` opens `e` with
   its key and posts the notification; if it can't, it posts "A thread needs
   you". A token Firebase says is unregistered (404) is dropped like an Apple
   one.

A relay with no `FCM_SERVICE_ACCOUNT` answers an Android send with
`relay not configured`, which the backend reports as failing pushes
(`pushHealth`). Deploy the relay before a backend that has Android phones.

## Registering

`/register` is open to anyone, so it can't simply hand out installs from
one shared daily allowance: a script used to be able to use all 500 up and
stop every new backend from getting notifications (Daybreak scan, 5 Nov
2026). Callers can't be told apart by address either, since every backend
calls from Convex's servers. So a backend from 5 Nov sends its own
deployment address (`CONVEX_SITE_URL`) and a random nonce, which it also
keeps in its `relayChecks` table. The relay posts `{ nonce }` to that
deployment's `/relay/verify` (`convex/http.ts`), which says yes only to a
nonce it made in the last five minutes, once. Only someone running the
deployment passes, so each deployment gets one install (registering again
gives it a new key) and nobody can use up anyone else's. The relay only
calls back to `https://<name>[.<region>].convex.site`, and never follows a
redirect from there (`redirect: 'error'`, and a yes only counts from the
address it asked): any deployment could answer 307 and have the relay post
on to a host of its choosing (Daybreak, 16 Nov 2026).

The check proves a caller runs the deployment, not that it runs
Threadbear, and anyone can make Convex deployments. So on top of each
install's own limits there are relay-wide ones (Daybreak, 16 Nov 2026),
sized well above real use:

- At most 100 deployments the relay hasn't seen before register in a UTC
  day. One it knows can always register again, including one whose
  install expired, so made-up deployments using up a day's new installs
  can't keep a real backend out. `/register` checks a deployment is under
  its limits before calling it back. That check counts nothing, as it
  runs before the call-back says who's asking, so a deployment that keeps
  saying no can keep being called back (only ever at its own convex.site
  address). Installs from before 5 Nov 2026, which couldn't register
  again, never expire.
- Installs under a week old share 600 sends an hour, and all installs
  together get 6,000. Past either, each install still gets the first 10
  sends of its hour, so no pile of installs can stop a real backend's
  notifications altogether.
- An install gets 20 sends an hour that fail on a bad device token
  (Apple's BadDeviceToken, DeviceTokenNotForTopic or Unregistered,
  Firebase's UNREGISTERED, INVALID_ARGUMENT or SENDER_ID_MISMATCH),
  counting sends still out, so a burst at once is held to it too. An
  Android notification's sealed text goes only if it's base64 of at most
  3,000 characters, so it always fits Firebase's 4 KB (a bigger one goes
  without it, and the phone shows its stand-in, as anything over 4,000
  always did). The
  relay's own failures (a revoked key, Google refusing its sign-in, a
  timeout) don't count against anyone.
- Every hourly count goes by the UTC hour.

This slows made-up deployments down rather than stopping them: someone
making 100 a day and keeping each busy still adds a little each day. A
fork running its own relay gets the same limits, which one person won't
come near.

There's no unchecked way in. Backends from before 5 Nov 2026 used one,
with a shared daily allowance anyone could use up, and it went the same
day (the relay's only install then was Mike's, which kept working:
`/send` never asks how an install was made). So an older backend that
needs a new install has to update, and a backend not on Convex's own
hosts (self-hosted, a custom domain) can't use this relay: run your own
(it's `relay/`, with your own Apple key). The code is
`relay/convex/verify.ts` and `relay.ts`.

## The project

- Code: `relay/` (its own package and `convex/`). Convex project
  `threadbear-relay` on team mikec: prod `impartial-hound-393` (Sydney,
  `https://impartial-hound-393.ap-southeast-2.convex.site`), dev
  `clean-terrier-424`. Env: the same `APNS_*` as Threadbear's prod.
- Limits: 120 sends an hour per install; 20 registrations a day per
  deployment; and the relay-wide ones in "Registering" above
  (`relay/convex/relay.ts` has them all). `newInstalls` in each day of
  `relay:stats` counts the deployments that registered for the first time.
- Stats for Mike: `npx convex run relay:stats --prod` in `relay/`. Each
  day's `reasons` tallies the failures as `"<status> <reason>"` (since 6
  Nov 2026), and the relay's own log has a `[send] failed:` line for each
  (status and reason only). `versions` counts installs by the version
  their backend says (`api-52`), which anyone with an install can set:
  it's stored only if it's a plain word (`/^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/`,
  else `unknown`) and counted in a Map, with anything stored before that
  rule as `other`, since one `$x`, `é` or `toString` broke the query
  for good (6 Nov 2026).
- Its Apple key is Poddle's (same team, so it signs for any of Mike's
  apps). Poddle moved to a new key and the old one was revoked, and from
  5 Nov 2026 every send failed with `403 InvalidProviderToken` until 6 Nov,
  when the relay and Threadbear's prod got the new key. If Poddle's key
  changes again, copy `APNS_KEY_P8` and `APNS_KEY_ID` to both. To check a
  key without a real phone: `npx convex run apns:send
  '{"deviceToken":"<64 zeros>","environment":"production","threadId":"probe"}' --prod`
  in `relay/` answers `400 BadDeviceToken` when Apple takes the key.
- A backend hears when its pushes stop getting through: each send's
  outcome goes in its `pushHealth` row (`convex/pushHealth.ts`), and the
  owner runner's heartbeat carries `pushFailing` to `tb status` and a
  notice in the app (docs/protocol/moves.md, "Sync").
- Deploy: `npm ci` then `npx convex deploy` in `relay/`, signed in to the
  Convex CLI as Mike (it isn't part of the runner's backend deploy, which
  is for each person's own deployment).
