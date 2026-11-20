#!/usr/bin/env node
// Gathers a night of scripts/nightly-fuzz.sh into <night>/summary.json, after
// each round and once at the end (--done): what ran, and every candidate
// finding with where its evidence is. The morning job on Mike's Mac reads it
// and decides what's real; this only collects.
//
//   node scripts/nightly-fuzz-summary.mjs <night dir> <busy waits> [--done]
import fs from 'node:fs';
import path from 'node:path';

const [night, busyWaits = '0', done] = process.argv.slice(2);
const lines = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } }) : []);
const files = (dir, re) => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => re.test(f)).map((f) => path.join(dir, f)) : []);
const rounds = lines(path.join(night, 'rounds.jsonl'));
const findings = [];
const ran = { stress: { rounds: 0, scenarios: 0, failed: 0 }, agent: { rounds: 0, sessions: 0, reports: 0, cost: 0 }, monkey: { rounds: 0, steps: 0, findings: 0 } };

for (const r of rounds) {
  ran[r.kind].rounds += 1;
  if (r.kind === 'stress') {
    const results = lines(path.join(r.dir, 'results.jsonl'));
    const cond = r.what ?? '';
    ran.stress.scenarios += results.length;
    for (const x of results.filter((x) => x.status === 'FAILED')) {
      ran.stress.failed += 1;
      findings.push({ kind: 'stress', title: `${x.uri}: ${x.name}`, condition: cond, detail: x.message, evidence: path.join(r.dir, 'failures'), round: r.n });
    }
  } else if (r.kind === 'monkey') {
    for (const f of files(r.dir, /^run-\d+\.json$/)) {
      const run = JSON.parse(fs.readFileSync(f, 'utf8'));
      ran.monkey.steps += run.steps ?? 0;
      for (const x of run.findings ?? []) {
        ran.monkey.findings += 1;
        findings.push({ kind: 'monkey', title: `${x.kind} at step ${x.step}`, detail: x.detail, repeats: x.repeats, seed: run.seed, evidence: x.dir, round: r.n });
      }
    }
  } else if (r.kind === 'agent') {
    for (const session of fs.existsSync(r.dir) ? fs.readdirSync(r.dir).map((d) => path.join(r.dir, d)).filter((d) => fs.statSync(d).isDirectory()) : []) {
      ran.agent.sessions += 1;
      const log = lines(path.join(session, 'session.jsonl'));
      const totals = log.find((x) => x.kind === 'end')?.totals ?? {};
      ran.agent.cost += totals.cost ?? 0;
      const start = log.find((x) => x.kind === 'start') ?? {};
      for (const x of log.filter((x) => x.kind === 'report')) {
        ran.agent.reports += 1;
        const bug = typeof x.bug === 'string' ? { title: x.bug } : x.bug ?? {};
        findings.push({ kind: 'agent', title: bug.title ?? bug.summary ?? JSON.stringify(bug).slice(0, 120), detail: bug, model: start.model, area: start.area, step: x.step, evidence: session, round: r.n });
      }
      for (const x of log.filter((x) => x.kind === 'harness')) {
        findings.push({ kind: 'agent-harness', title: x.problem ?? 'app unhealthy during a session', detail: x, evidence: session, round: r.n });
      }
    }
  }
}

const summary = { night: path.basename(night), done: Boolean(done), updated: new Date().toISOString(), busyWaits: Number(busyWaits), ran, findings };
fs.writeFileSync(path.join(night, 'summary.json'), JSON.stringify(summary, null, 2));
