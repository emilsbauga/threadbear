// Imported first by a test that wants Windows' clicks-only rule on
// anywhere: platform.ts reads THREADBEAR_CLICKS_ONLY once, as it loads, so
// the value must be set before anything imports it.
process.env.THREADBEAR_CLICKS_ONLY = '1';
