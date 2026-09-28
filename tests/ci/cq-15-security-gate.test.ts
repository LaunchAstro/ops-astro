// SPDX-License-Identifier: AGPL-3.0-only
//
// CQ-15: the security gate. `scripts/security-gate.mjs` judges a `pnpm audit` or Semgrep report
// against `.github/security-exceptions.json`; ci.yml runs it, and the isolation suites, on every
// pull request. Each case is named after a line of the ticket's supporting checklist.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { enrol, grantTo, installSpine } from '../commands/fixture.ts';
import { insertBusiness } from '../identity/fixture.ts';
import {
  createFreshDatabase,
  databaseUrlFromEnvironment,
  type FreshDatabase,
} from '../../packages/core-records/src/tenancy/testing/fresh-database.ts';

const ROOT = join(import.meta.dirname, '../..');
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');
const TOKEN = 'CQ15_MATCHED_TEXT_NEVER_PRINTED';
const HELD = { reason: 'r', impact: 'i', owner: 'o', control: 'c', expires: '2026-09-28' };
const GHSA = 'GHSA-cq15-0000-0000';
const MOD = { audit: [{ advisory: GHSA, ...HELD }] };
const RULE = { rule: 'r.x', path: 'a.ts', count: 1, ...HELD };
const run = (args: string[], env = process.env) =>
  spawnSync('node', ['scripts/security-gate.mjs', ...args], { cwd: ROOT, env, encoding: 'utf8' });

/** The gate on a report and an exceptions file in a scratch directory, on 28 September. */
function gate(kind: string, report: unknown, exceptions: object = {}, today = '2026-09-28') {
  const dir = mkdtempSync(join(tmpdir(), 'cq15-'));
  const [r, x] = [join(dir, 'report.json'), join(dir, 'exceptions.json')];
  writeFileSync(r, typeof report === 'string' ? report : JSON.stringify(report));
  writeFileSync(x, JSON.stringify({ audit: [], semgrep: [], ...exceptions }));
  const done = run([kind, '--report', r, '--exceptions', x, '--today', today]);
  return { status: done.status, out: done.stdout + done.stderr };
}
const advisory = (severity: string) => ({
  advisories: { 1: { github_advisory_id: GHSA, module_name: 'planted', severity } },
});
const extra = { lines: TOKEN };
const hit = (check_id = 'r.x') => ({ check_id, path: 'a.ts', start: { line: 3 }, extra });
type List = unknown[];
const scan = (results: List, errors: List = [], scanned = ['a.ts']) => ({
  results,
  errors,
  paths: { scanned },
});

/** One job's block of ci.yml, from its name to the next job's key. */
function job(name: string): string {
  const text = read('.github/workflows/ci.yml');
  const start = text.indexOf(`    name: ${name}\n`);
  const next = text.slice(start).search(/\n {2}[\w-]+:\n/u);
  return start === -1 ? '' : text.slice(start, next === -1 ? undefined : start + next);
}

/** [label, kind, report, exceptions, exit status, today] */
type Case = [string, string, unknown, object, number, string?];
const each = (cases: Case[]) =>
  expect(cases.map(([l, k, r, x, , t]) => `${l}: ${gate(k, r, x, t).status}`)).toEqual(
    cases.map(([l, , , , s]) => `${l}: ${s}`),
  );

describe('CQ-15 security gate', () => {
  it('CQ-15 audit on every pull request: fails on high or critical, and on an unlisted moderate', () => {
    expect(job('dependency audit')).toContain('pnpm audit --json');
    expect(job('dependency audit')).toContain('scripts/security-gate.mjs audit');
    each([
      ['high', 'audit', advisory('high'), {}, 1],
      ['critical, even listed', 'audit', advisory('critical'), MOD, 1],
      ['moderate, unlisted', 'audit', advisory('moderate'), {}, 1],
      ['moderate, listed', 'audit', advisory('moderate'), MOD, 0],
      ['low', 'audit', advisory('low'), {}, 0],
      ['none', 'audit', { advisories: {} }, {}, 0],
      ['not a report', 'audit', 'ERR_PNPM_AUDIT_BAD_RESPONSE', {}, 1],
    ]);
  });

  it('CQ-15 semgrep three rulesets: each ignored finding has a reason, and a new finding fails', () => {
    const block = job('static analysis');
    expect(block).toContain('--config p/default --config p/secrets --config p/typescript');
    expect(block).toMatch(/semgrep\/semgrep:[\d.]+@sha256:[0-9a-f]{64}/u);
    const listed = { semgrep: [RULE] };
    each([
      ['listed', 'semgrep', scan([hit()]), listed, 0],
      ['unlisted', 'semgrep', scan([hit()]), {}, 1],
      ['one more than listed', 'semgrep', scan([hit(), hit()]), listed, 1],
      ['another rule', 'semgrep', scan([hit('r.other')]), listed, 1],
      ['listed, matched nothing', 'semgrep', scan([]), listed, 1],
      ['scanner error', 'semgrep', scan([], [{ level: 'error' }]), {}, 1],
      ['partial-parse warning', 'semgrep', scan([], [{ level: 'warn' }]), {}, 0],
      ['scanned nothing', 'semgrep', scan([], [], []), {}, 1],
      ['no report', 'semgrep', '', {}, 1],
    ]);
  });

  it('CQ-15 exception expiry: each names impact, owner, control and expiry, and fails once expired', () => {
    const one = (entry: object) => ({ semgrep: [{ ...RULE, ...entry }] });
    const field = (f: string): Case => [f, 'semgrep', scan([hit()]), one({ [f]: ' ' }), 1];
    const blank = Object.keys(HELD).map(field);
    each([
      ['expired semgrep', 'semgrep', scan([hit()]), one({}), 1, '2026-09-29'],
      ['expired audit', 'audit', advisory('moderate'), MOD, 1, '2026-09-29'],
      ...blank,
      ['no such day', 'semgrep', scan([hit()]), one({ expires: '2026-02-30' }), 1],
      ['over a year', 'semgrep', scan([hit()]), one({ expires: '2027-09-30' }), 1],
      ['a year', 'semgrep', scan([hit()]), one({ expires: '2027-09-28' }), 0],
    ]);
  });

  it('CQ-15 isolation suites on a real Postgres: the four families, each also named in the manifest', () => {
    const block = job('isolation tests');
    expect(block).toMatch(/image: postgres@sha256:[0-9a-f]{64}/u);
    expect(block).toContain('scripts/db-conformance.mjs --manifest tests/db/isolation-suites.json');
    type Suites = { invariant: string[] };
    const { invariant } = JSON.parse(read('tests/db/isolation-suites.json')) as Suites;
    const families = 'external-party restricted-calls pooled-crossover role-case-matrix cq-15';
    expect(families.split(' ').filter((f) => !invariant.some((s) => s.includes(f)))).toEqual([]);
    const named = read('tests/db/named-suites.json');
    expect(invariant.filter((s) => !named.includes(`"${s}"`))).toEqual([]);
  });

  it('CQ-15 no secret printed: the gate reports rule and place, never the match, and the jobs hold no secret', () => {
    const { status, out } = gate('semgrep', scan([hit()]));
    expect(`${status} ${out.includes(TOKEN)} ${out.includes('a.ts:3')}`).toBe('1 false true');
    for (const name of ['dependency audit', 'static analysis', 'isolation tests']) {
      expect(job(name), name).not.toBe('');
      expect(job(name).match(/secrets\.|GITHUB_TOKEN|permissions:/u), name).toBeNull();
    }
    expect(read('.github/workflows/ci.yml')).toMatch(/^permissions:\n {2}contents: read$/mu);
  });
});

describe.skipIf(databaseUrlFromEnvironment() === undefined)('CQ-15 isolation', () => {
  let db: FreshDatabase;
  const parties: string[] = [];

  beforeAll(async () => {
    db = await createFreshDatabase({ part: 'cq15' });
    const party = async (key: string) => {
      const id = await insertBusiness(db.app, key);
      await installSpine(db.app, id);
      const member = await enrol(db.app, id, `${key}-member`);
      const client = await enrol(db.app, id, `${key}-client`);
      await db.app.withBusiness(id, async (tx) => {
        await grantTo(tx, member, 'write');
        await grantTo(tx, client, 'read');
      });
      return id;
    };
    // One after the other: installSpine and the grants read the shared catalogue.
    parties.push(await party('bravo'), await party('charlie'));
  }, 60_000);

  afterAll(async () => await db?.drop());

  it('CQ-15 isolation: two businesses, two clients, one grant each; the gate reaches neither', async () => {
    const sql = `select (select count(*) from grants where business_id = $1)::int
      + (select count(*) from audit_events where business_id = $1)::int as n`;
    const one = async (id: string) => (await db.admin.execute<{ n: number }>(sql, [id]))[0]?.n;
    const count = async () => Promise.all(parties.map(one));
    const before = await count();
    const env = { ...process.env, DATABASE_URL: db.appUrl };
    const runs = ['semgrep', 'audit'].map((kind) => run([kind, '--report', '/dev/null'], env));
    const out = runs.map((r) => r.stdout + r.stderr).join('');
    const named = parties.some((id) => out.includes(id));
    expect(`${runs.map((r) => r.status).join(' ')} ${named}`).toBe('1 1 false');
    expect([await count(), before.every((n) => (n ?? 0) > 0)]).toEqual([before, true]);
  });
});
