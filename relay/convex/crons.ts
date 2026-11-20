// Once a day: forget installs nobody has used in 90 days and old hourly
// pools (relay.ts expire).
import { cronJobs } from 'convex/server';
import { internal } from './_generated/api';

const crons = cronJobs();
crons.daily('expire idle installs', { hourUTC: 17, minuteUTC: 30 }, internal.relay.expire, {});
export default crons;
