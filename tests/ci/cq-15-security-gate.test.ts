// SPDX-License-Identifier: AGPL-3.0-only
//
// CQ-15: the security gate. `scripts/security-gate.mjs` judges a `pnpm audit` or Semgrep report
// against `.github/security-exceptions.json`; ci.yml runs it, and the isolation suites, on every
// pull request. Each case is named after a line of the ticket's supporting checklist.

import { execFile, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
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
/** a.ts: line 1 is the excepted code, line 2 other code, line 3 line 1's code moved. */
const LINES = [`x('${TOKEN}');`, 'y(2);', `x('${TOKEN}');`];
const sha = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 16);
const [matches, file] = [[sha(LINES[0] ?? '')], sha(LINES.join('\n'))];
const RULE = { rule: 'r.x', path: 'a.ts', matches, file, ...HELD };
const GATE = 'scripts/security-gate.mjs';

/** The gate's arguments on a report and an exceptions file, in a scratch directory with a.ts. */
function scratch(report: unknown, exceptions: object, source = LINES.join('\n')) {
  const dir = mkdtempSync(join(tmpdir(), 'cq15-'));
  const [r, x] = [join(dir, 'report.json'), join(dir, 'exceptions.json')];
  writeFileSync(r, typeof report === 'string' ? report : JSON.stringify(report));
  writeFileSync(x, JSON.stringify({ audit: [], semgrep: [], ...exceptions }));
  writeFileSync(join(dir, 'a.ts'), source);
  return ['--report', r, '--exceptions', x, '--root', dir];
}
function gate(kind: string, report: unknown, exceptions: object = {}, today = '2026-09-28') {
  const args = [GATE, kind, ...scratch(report, exceptions), '--today', today];
  const done = spawnSync('node', args, { cwd: ROOT, encoding: 'utf8' });
  return { status: done.status, out: done.stdout + done.stderr };
}
const advisory = (severity: string) => ({
  advisories: { 1: { github_advisory_id: GHSA, module_name: 'planted', severity } },
});
/** A finding on one whole line of a.ts, at the byte offsets Semgrep reports. */
function hit(line = 1, check_id = 'r.x', path = 'a.ts', lines = LINES) {
  const offset = lines.slice(0, line - 1).join('\n').length + (line > 1 ? 1 : 0);
  const end = { line, offset: offset + (lines[line - 1] ?? '').length };
  return { check_id, path, start: { line, offset }, end };
}
type L = unknown[];
const scan = (results: L, errors: L = [], s = ['a.ts']) => ({
  results,
  errors,
  paths: { scanned: s },
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
      ['the same code moved', 'semgrep', scan([hit(3)]), listed, 0],
      ['other code in its place', 'semgrep', scan([hit(2)]), listed, 1],
      ['one more than listed', 'semgrep', scan([hit(1), hit(3)]), listed, 1],
      ['another rule', 'semgrep', scan([hit(1, 'r.other')]), listed, 1],
      ['source not on disk', 'semgrep', scan([hit(1, 'r.x', 'b.ts')]), listed, 1],
      ['listed, matched nothing', 'semgrep', scan([]), listed, 1],
      ['scanner error', 'semgrep', scan([], [{ level: 'error' }]), {}, 1],
      ['partial-parse warning', 'semgrep', scan([], [{ level: 'warn' }]), {}, 0],
      ['scanned nothing', 'semgrep', scan([], [], []), {}, 1],
      ['no report', 'semgrep', '', {}, 1],
    ]);
  });

  it('Sol proof, criterion 6: a changed caller or missing file binding invalidates an exception', () => {
    const expression = 'new RegExp(name)';
    const baseline = [
      'function parse(name: string) {',
      `  return ${expression};`,
      '}',
      "parse('FIXED');",
    ].join('\n');
    const changed = `${baseline}\nfunction fromRequest(name: string) { return parse(name); }`;
    const exception = {
      rule: 'javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp',
      path: 'a.ts',
      matches: [createHash('sha256').update(expression).digest('hex').slice(0, 16)],
      file: createHash('sha256').update(baseline).digest('hex').slice(0, 16),
      reason: 'The only caller passes a fixed name.',
      impact: 'No caller-controlled pattern.',
      owner: 'Maintainer',
      control: 'Review changes to the source file.',
      expires: '2026-12-28',
    };
    const runOn = (source: string, listed: object) => {
      const offset = source.indexOf(expression);
      const line = source.slice(0, offset).split('\n').length;
      const finding = {
        check_id: exception.rule,
        path: 'a.ts',
        start: { line, offset },
        end: { line, offset: offset + expression.length },
      };
      const args = [
        GATE,
        'semgrep',
        ...scratch(scan([finding]), { semgrep: [listed] }, source),
        '--today',
        '2026-09-28',
      ];
      return spawnSync('node', args, { cwd: ROOT, encoding: 'utf8' }).status;
    };

    expect(runOn(baseline, exception), 'the reviewed file and finding').toBe(0);
    expect(runOn(changed, exception), 'a new caller changes the reviewed file').toBe(1);
    expect(runOn(baseline, { ...exception, file: undefined }), 'an unbound exception').toBe(1);
  });

  it('CQ-15 exception expiry: each names impact, owner, control and expiry, and fails once expired', () => {
    const one = (entry: object) => ({ semgrep: [{ ...RULE, ...entry }] });
    const field = (f: string): Case => [f, 'semgrep', scan([hit()]), one({ [f]: ' ' }), 1];
    each([
      ['expired semgrep', 'semgrep', scan([hit()]), one({}), 1, '2026-09-29'],
      ['expired audit', 'audit', advisory('moderate'), MOD, 1, '2026-09-29'],
      ...Object.keys(HELD).map(field),
      ['no such day', 'semgrep', scan([hit()]), one({ expires: '2026-02-30' }), 1],
      ['over a year', 'semgrep', scan([hit()]), one({ expires: '2027-09-30' }), 1],
      ['a year', 'semgrep', scan([hit()]), one({ expires: '2027-09-28' }), 0],
    ]);
  });

  it('CQ-15 isolation suites on a real Postgres: the four families, each also named in the manifest', () => {
    const block = job('isolation tests');
    expect(block).toMatch(/image: postgres@sha256:[0-9a-f]{64}/u);
    expect(block).toContain('scripts/db-conformance.mjs --manifest tests/db/isolation-suites.json');
    const { invariant } = JSON.parse(read('tests/db/isolation-suites.json')) as { invariant: L };
    const named = read('tests/db/named-suites.json');
    for (const family of 'external-party restricted-calls pooled-crossover role-case-matrix cq-15'.split(
      ' ',
    ))
      expect(
        invariant.some((s) => String(s).includes(family)),
        family,
      ).toBe(true);
    expect(invariant.filter((s) => !named.includes(`"${String(s)}"`))).toEqual([]);
  });

  it('CQ-15 no secret printed: the gate reports rule and place, never the match, and the jobs hold no secret', () => {
    const { status, out } = gate('semgrep', scan([hit()]));
    expect(`${status} ${out.includes(TOKEN)} ${out.includes('a.ts:1')}`).toBe('1 false true');
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
    const before = await Promise.all(parties.map(one));
    // The database's place is taken by a listener that counts every connection made to it.
    let reached = 0;
    const listener = createServer((socket) => ++reached && socket.destroy()).listen(0, '127.0.0.1');
    await new Promise((up) => listener.once('listening', up));
    const { port } = listener.address() as AddressInfo;
    const url = `postgres://cq15:cq15@127.0.0.1:${port}/cq15`;
    const env = { ...process.env, DATABASE_URL: url, PGHOST: '127.0.0.1', PGPORT: String(port) };
    const node = (args: string[]) =>
      new Promise<string>((done) =>
        execFile('node', args, { cwd: ROOT, env }, (e, out, err) =>
          done(`${e?.code ?? 0} ${out}${err}`),
        ),
      );
    // The positive control: a process that opens DATABASE_URL is counted.
    const control = "new (require('pg').Client)(process.env.DATABASE_URL).connect().catch(() => 0)";
    await node(['-e', control]);
    // Charlie's id and client name are the matched source of the finding the gate judges.
    const source = [`x('${parties[1]} charlie-client');`];
    const runs = [
      await node([
        GATE,
        'semgrep',
        ...scratch(scan([hit(1, 'r.x', 'a.ts', source)]), {}, source[0]),
      ]),
      await node([GATE, 'audit', ...scratch({ advisories: {} }, {})]),
    ];
    listener.close();
    const named = [...parties, 'charlie-client'].some((x) => runs.join('').includes(x));
    const statuses = runs.map((o) => o.split(' ')[0]).join(' ');
    expect(`${statuses} reached=${reached} named=${named}`).toBe('1 0 reached=1 named=false');
    expect([await Promise.all(parties.map(one)), before.every(Boolean)]).toEqual([before, true]);
  });
});
