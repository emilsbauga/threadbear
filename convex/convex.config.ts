import { v } from 'convex/values';
import { defineApp } from 'convex/server';
import staticHosting from '@convex-dev/static-hosting/convex.config.js';
import stateMachines from '@convex-dev/state-machines/convex.config.js';

// The website (web/) is served from the deployment's own .convex.site URL,
// so a thread has a link: https://<deployment>.convex.site/t/<threadId>.
// The app owns HTTP routing (http.ts) rather than mounting the component's
// routes at /, so a shared thread's /s/<slug> page can carry its own title
// and picture for link previews, with the static catch-all behind it.
const app = defineApp({
  env: {
    APNS_KEY_ID: v.optional(v.string()),
    APNS_KEY_P8: v.optional(v.string()),
    APNS_TEAM_ID: v.optional(v.string()),
    APNS_TOPIC: v.optional(v.string()),
    PUSH_RELAY: v.optional(v.string()),
    PUSH_RELAY_URL: v.optional(v.string()),
    PUSH_VIA: v.optional(v.string()),
  },
});
app.use(staticHosting);
// The state machines' history (machines.ts): a fact per step, read by the
// Machines page (convex/viewer.ts).
app.use(stateMachines);
export default app;
