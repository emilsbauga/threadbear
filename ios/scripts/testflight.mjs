// The App Store Connect side of the nightly TestFlight build (nightly-testflight.sh). Mike's only:
// it needs the team's API key (appstore-lib.mjs), which a fork doesn't have.
//
//   node ios/scripts/testflight.mjs version <project version>
//       the version to build: the project's, unless App Store Connect has closed that train (the
//       version is approved or out), then one patch past the newest closed one
//   node ios/scripts/testflight.mjs group
//       makes sure the internal group exists, gets every build, and has the account holder in it
//   node ios/scripts/testflight.mjs finish <build> <notes file>
//       waits for App Store Connect to process the build, gives it What to Test, and checks it's
//       in the group
//
// Internal testers need no Beta App Review, so a build reaches TestFlight as soon as it's processed.
import { readFileSync } from "node:fs";
import { api, appId, get, getAll } from "./appstore-lib.mjs";

/** The internal TestFlight group Mike's phone takes every build from. */
export const GROUP = "Mike (nightly)";

/** Versions App Store Connect still takes builds for; anything else is approved or out. */
const OPEN = new Set([
  "PREPARE_FOR_SUBMISSION", "READY_FOR_REVIEW", "WAITING_FOR_REVIEW", "IN_REVIEW",
  "DEVELOPER_REJECTED", "REJECTED", "METADATA_REJECTED", "INVALID_BINARY",
  "WAITING_FOR_EXPORT_COMPLIANCE",
]);

const parse = (v) => v.split(".").map((n) => Number(n) || 0);
export function cmp(a, b) {
  const x = parse(a), y = parse(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
  }
  return 0;
}
export function bump(v) {
  const p = parse(v);
  while (p.length < 3) p.push(0);
  p[p.length - 1] += 1;
  return p.join(".");
}

/** The project's version, or one past the newest closed train when that's later. */
export function pickVersion(projectVersion, versions) {
  const closed = versions.filter((v) => !OPEN.has(v.state)).map((v) => v.version).sort(cmp);
  const newest = closed.at(-1);
  if (!newest || cmp(projectVersion, newest) > 0) return projectVersion;
  return bump(newest);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function version(projectVersion) {
  if (!/^\d+(\.\d+){0,2}$/.test(projectVersion ?? "")) throw new Error(`not a version: ${projectVersion}`);
  const id = await appId();
  const versions = (await getAll(`/v1/apps/${id}/appStoreVersions?limit=50`)).map((v) => ({
    version: v.attributes.versionString,
    state: v.attributes.appVersionState ?? v.attributes.appStoreState,
  }));
  console.log(pickVersion(projectVersion, versions));
}

async function group() {
  const id = await appId();
  const groups = await getAll(`/v1/apps/${id}/betaGroups?limit=50`);
  let g = groups.find((x) => x.attributes.name === GROUP);
  if (!g) {
    g = (await api("POST", "/v1/betaGroups", {
      data: {
        type: "betaGroups",
        attributes: { name: GROUP, isInternalGroup: true, hasAccessToAllBuilds: true },
        relationships: { app: { data: { type: "apps", id } } },
      },
    })).data;
    console.error(`made the internal group "${GROUP}"`);
  }
  // The account holder is Mike. The email is never printed.
  const users = await getAll("/v1/users?limit=50");
  const mike = users.find((u) => u.attributes.roles.includes("ACCOUNT_HOLDER"));
  if (!mike) throw new Error("no account holder among the App Store Connect users");
  const email = mike.attributes.username;
  const testers = await getAll(`/v1/betaGroups/${g.id}/betaTesters?limit=50`);
  if (!testers.some((t) => t.attributes.email?.toLowerCase() === email.toLowerCase())) {
    await api("POST", "/v1/betaTesters", {
      data: {
        type: "betaTesters",
        attributes: { email, firstName: mike.attributes.firstName, lastName: mike.attributes.lastName },
        relationships: { betaGroups: { data: [{ type: "betaGroups", id: g.id }] } },
      },
    });
    console.error("added the account holder to it; TestFlight sends an invite the first time");
  }
  console.log(g.id);
  return g.id;
}

async function finish(buildNumber, notesFile) {
  const id = await appId();
  const groupId = await group();
  let build;
  // Processing usually takes 5 to 20 minutes.
  for (let i = 0; i < 120; i++) {
    build = (await get(`/v1/builds?filter[app]=${id}&filter[version]=${buildNumber}&limit=1`)).data[0];
    const state = build?.attributes?.processingState ?? "not there yet";
    if (state === "VALID") break;
    if (state === "FAILED" || state === "INVALID") throw new Error(`build ${buildNumber} is ${state}`);
    if (i % 10 === 0) console.error(`build ${buildNumber}: ${state}, waiting…`);
    build = undefined;
    await sleep(30_000);
  }
  if (!build) throw new Error(`build ${buildNumber} wasn't processed within an hour`);
  // Info.plist says no non-exempt encryption; set it here too if it didn't come through, or the
  // build sits at Missing Compliance and never reaches the phone.
  if (build.attributes.usesNonExemptEncryption == null) {
    await api("PATCH", `/v1/builds/${build.id}`, {
      data: { type: "builds", id: build.id, attributes: { usesNonExemptEncryption: false } },
    });
  }
  const notes = readFileSync(notesFile, "utf8").trim().slice(0, 3900);
  if (notes) {
    const locs = (await get(`/v1/builds/${build.id}/betaBuildLocalizations`)).data;
    if (locs[0]) {
      await api("PATCH", `/v1/betaBuildLocalizations/${locs[0].id}`, {
        data: { type: "betaBuildLocalizations", id: locs[0].id, attributes: { whatsNew: notes } },
      });
    } else {
      await api("POST", "/v1/betaBuildLocalizations", {
        data: {
          type: "betaBuildLocalizations",
          attributes: { locale: "en-AU", whatsNew: notes },
          relationships: { build: { data: { type: "builds", id: build.id } } },
        },
      });
    }
  }
  // The group gets every build by itself (hasAccessToAllBuilds; App Store Connect refuses adding
  // one to an internal group by hand), once the build's internal state is In testing.
  let state;
  for (let i = 0; i < 20; i++) {
    state = (await get(`/v1/builds/${build.id}/buildBetaDetail`)).data.attributes.internalBuildState;
    if (state === "IN_BETA_TESTING") break;
    await sleep(30_000);
  }
  if (state !== "IN_BETA_TESTING") throw new Error(`build ${buildNumber} is ${state} for internal testers, not IN_BETA_TESTING`);
  console.log(`build ${buildNumber} is VALID and in testing for "${GROUP}"`);
}

const [cmd, ...args] = process.argv.slice(2);
if (import.meta.url === `file://${process.argv[1]}`) {
  const run = { version, group, finish }[cmd];
  if (!run) {
    console.error("usage: testflight.mjs version <v> | group | finish <build> <notes file>");
    process.exit(2);
  }
  run(...args).catch((e) => {
    console.error(`✗ ${e.message}`);
    process.exit(1);
  });
}
