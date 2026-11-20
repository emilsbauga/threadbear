import { defineApp } from 'convex/server';
import staticHosting from '@convex-dev/static-hosting/convex.config.js';
import stateMachines from '@convex-dev/state-machines/convex.config.js';

// The website (web/) is served from the deployment's own .convex.site URL,
// so a thread has a link: https://<deployment>.convex.site/t/<threadId>.
// The app owns HTTP routing (http.ts) rather than mounting the component's
// routes at /, so a shared thread's /s/<slug> page can carry its own title
// and picture for link previews, with the static catch-all behind it.
const app = defineApp();
app.use(staticHosting);
// The state machines' history (machines.ts): a fact per step, read by the
// Machines page (convex/viewer.ts).
app.use(stateMachines);
export default app;
