// SPDX-License-Identifier: AGPL-3.0-only
// Upgrade drill row declarations (ORCH47) and explicit empty-table drops.

import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import {
  MARKS,
  AD_HOC,
  COMMENT_OWNERS,
  STATE_OWNERS,
  type Planted,
} from './upgrade-drill.fixture.ts';

const serverUrl = databaseUrlFromEnvironment();
const scratch: string[] = [];
const FAMILY_M = '0073';
/** Replay 0073, 0074, 0075 and 0083 after the schema preceding that family. */
function withPlanted(planted: readonly Planted[]): string {
  const directory = mkdtempSync(join(tmpdir(), 'upgrade-drill-declared-'));
  scratch.push(directory);
  for (const file of readdirSync('migrations')) {
    if (/\.(sql|changes\.json)$/u.test(file) && file < FAMILY_M) {
      copyFileSync(join('migrations', file), join(directory, file));
    }
  }
  for (const one of planted) {
    writeFileSync(join(directory, `${one.version}.sql`), `${one.sql}\n`);
    if (one.changes !== undefined) {
      writeFileSync(join(directory, `${one.version}.changes.json`), JSON.stringify(one.changes));
    }
  }
  return directory;
}
interface DrillResult {
  readonly ok: boolean;
  readonly differences: readonly {
    readonly table: string;
    readonly changedOrLost: number;
    readonly gone: boolean;
  }[];
  readonly declared: readonly {
    readonly migration: string;
    readonly table: string;
    readonly rows: number;
  }[];
}

function drill(
  directory: string,
  from = '0041',
  base?: string,
): {
  status: number | null;
  output: string;
  result: DrillResult | undefined;
} {
  const run = spawnSync(
    process.execPath,
    [
      'scripts/local/upgrade-drill.mjs',
      '--from',
      from,
      '--migrations',
      directory,
      '--json',
      ...(base === undefined ? [] : ['--base', base]),
    ],
    { encoding: 'utf8', env: { ...process.env, DATABASE_ADMIN_URL: serverUrl } },
  );
  const last = run.stdout.trim().split('\n').at(-1) ?? '';
  return {
    status: run.status,
    output: run.stdout + run.stderr,
    result: last.startsWith('{') ? (JSON.parse(last) as DrillResult) : undefined,
  };
}

afterAll(() => {
  for (const directory of scratch) rmSync(directory, { recursive: true, force: true });
});

const DROP_BASE = '57ccaa516834304415ec2fbdca7d08f15e32bc50';
const DROP_FROM = '20261013110100_live_correction_proposals';
const TOKEN_TABLE = 'public.password_reset_tokens';
const DROP = { table: TOKEN_TABLE, drop: true };
const DROP_SQL = `drop function public.password_reset_token_find(text); drop table ${TOKEN_TABLE}`;

describe.skipIf(serverUrl === undefined)('S0-3 upgrade drill, declared changes', () => {
  declaredCases1();
  declaredCases2();
  dropPassCases();
  dropRefusalCases();
  dropBoundaryCases();
});

/** An undeclared change, and the four declared ones. */
function declaredCases1() {
  it('turns red when a migration changes slot reservations it did not declare', () => {
    const { changes: _declared, ...undeclared } = MARKS;
    const { status, result, output } = drill(withPlanted([undeclared]));
    expect(result, output).toBeDefined();
    expect(status).toBe(1);
    expect(result?.ok).toBe(false);
    expect(result?.differences).toContainEqual(
      expect.objectContaining({ table: 'ops.slots', changedOrLost: 3, gone: false }),
    );
  }, 180_000);

  it('stays green when the four declared slot and owner changes happen as declared', () => {
    const { status, result, output } = drill(
      withPlanted([MARKS, AD_HOC, COMMENT_OWNERS, STATE_OWNERS]),
    );
    expect(result?.differences, output).toStrictEqual([]);
    expect(result?.ok).toBe(true);
    expect(status).toBe(0);
    const rows = (migration: string): number =>
      result?.declared.find((one) => one.migration === migration)?.rows ?? 0;
    expect(rows(MARKS.version)).toBe(3);
    expect(rows(AD_HOC.version)).toBe(1);
    // One per business the seed made.
    expect(rows(COMMENT_OWNERS.version)).toBeGreaterThan(0);
    expect(rows(STATE_OWNERS.version)).toBeGreaterThan(0);
    expect(output).toMatch(/9996_planted_marks: ops\.slots, 3 declared rows changed/u);
  }, 180_000);
}

/** The pinned base's real schema, followed by one raw declaration to validate. */
function dropDrill(sql: string, changes?: unknown) {
  const directory = mkdtempSync(join(tmpdir(), 'upgrade-drill-drop-'));
  scratch.push(directory);
  const files = execFileSync('git', ['ls-tree', '--name-only', DROP_BASE, 'migrations/'], {
    encoding: 'utf8',
  })
    .trim()
    .split('\n');
  for (const file of files) copyFileSync(file, join(directory, file.slice('migrations/'.length)));
  writeFileSync(join(directory, '20991231000000_planted_drop.sql'), sql);
  if (changes !== undefined)
    writeFileSync(
      join(directory, '20991231000000_planted_drop.changes.json'),
      JSON.stringify(changes),
    );
  return drill(directory, DROP_FROM, DROP_BASE);
}

function dropPassCases() {
  it('confirms a declared empty table drop with zero rows through the CLI result and report', () => {
    const { status, result, output } = dropDrill(DROP_SQL, [DROP]);
    expect(status, output).toBe(0);
    expect(result?.ok).toBe(true);
    expect(result?.differences).toStrictEqual([]);
    expect(result?.declared).toContainEqual({
      migration: '20991231000000_planted_drop',
      table: TOKEN_TABLE,
      drop: true,
      rows: 0,
      dropped: true,
    });
    expect(output).toContain(`${TOKEN_TABLE}: declared empty table dropped, 0 rows lost`);
  }, 180_000);

  it('fails a retained declared table as an uncompleted drop rather than a row declaration', () => {
    const { status, result, output } = dropDrill('select 1', [DROP]);
    expect(status, output).toBe(1);
    expect(result?.ok).toBe(false);
    expect(result?.differences).toStrictEqual([]);
    expect(result?.declared).toContainEqual(expect.objectContaining({ rows: 0, dropped: false }));
    expect(output).toContain(`declared drop of ${TOKEN_TABLE} did not happen`);
    expect(output).toContain('0 table(s) changed and 1 declared change(s) missing');
  }, 180_000);

  it('still fails an undeclared empty table drop and reports the zero-row disappearance', () => {
    const { status, result, output } = dropDrill(DROP_SQL);
    expect(status, output).toBe(1);
    expect(result?.ok).toBe(false);
    expect(result?.differences).toContainEqual({
      table: TOKEN_TABLE,
      gone: true,
      changedOrLost: 0,
      added: 0,
    });
  }, 180_000);
}

function dropRefusalCases() {
  it.each([
    [
      'nonempty',
      [{ table: 'public.records', drop: true }],
      'drop declaration requires an empty table: public.records',
    ],
    [
      'absent before',
      [{ table: 'public.no_such_table', drop: true }],
      'no table public.no_such_table before the upgrade',
    ],
    ['duplicate', [DROP, DROP], `duplicate drop declaration for ${TOKEN_TABLE}`],
    [
      'mixed',
      [{ ...DROP, columns: ['id'], where: 'true' }],
      'drop declaration must contain only table and drop: true',
    ],
    [
      'false',
      [{ ...DROP, drop: false }],
      'drop declaration must contain only table and drop: true',
    ],
    [
      'string',
      [{ ...DROP, drop: 'true' }],
      'drop declaration must contain only table and drop: true',
    ],
  ])(
    'refuses the %s drop declaration for its specific guard',
    (_name, changes, reason) => {
      const { status, output } = dropDrill(DROP_SQL, changes);
      expect(status, output).toBe(2);
      expect(output).toContain(reason);
      expect(output).not.toContain('upgraded');
    },
    180_000,
  );
}

function dropBoundaryCases() {
  it('does not let a later row declaration excuse an earlier undeclared change', () => {
    const { status, result, output } = drill(
      withPlanted([
        { version: '9995_undeclared_marks', sql: MARKS.sql },
        { ...MARKS, sql: 'select 1' },
      ]),
    );
    expect(status, output).toBe(1);
    expect(result?.differences).toContainEqual(
      expect.objectContaining({ table: 'ops.slots', changedOrLost: 3 }),
    );
    expect(output).toContain('declared change to ops.slots did not happen');
  }, 180_000);

  it('does not let a row declaration excuse a later table drop', () => {
    const { status, result, output } = drill(
      withPlanted([
        MARKS,
        { version: '9997_undeclared_drop', sql: 'drop table ops.slots cascade' },
      ]),
    );
    expect(status, output).toBe(1);
    expect(result?.differences).toContainEqual(
      expect.objectContaining({ table: 'ops.slots', gone: true }),
    );
  }, 180_000);
}

/** A declaration that is not kept, or not there. */
function declaredCases2() {
  it('turns red when a declared change does not happen', () => {
    const { status, result, output } = drill(withPlanted([{ ...MARKS, sql: 'select 1' }]));
    expect(result, output).toBeDefined();
    expect(status).toBe(1);
    expect(result?.ok).toBe(false);
    expect(result?.differences).toStrictEqual([]);
    expect(output).toMatch(/9996_planted_marks: declared change to ops\.slots did not happen/u);
  }, 180_000);

  it('turns red when a declared row changes in a column it did not declare', () => {
    // The rows are the declared ones; the column the migration writes is not.
    const { status, result, output } = drill(
      withPlanted([{ ...MARKS, changes: [{ ...MARKS.changes![0]!, columns: ['value_type'] }] }]),
    );
    expect(result, output).toBeDefined();
    expect(status).toBe(1);
    expect(result?.differences).toContainEqual(
      expect.objectContaining({ table: 'ops.slots', changedOrLost: 3 }),
    );
  }, 180_000);

  it('never runs a second statement or a write smuggled into a predicate', () => {
    const smuggled = `slot in ('num_3', 'num_4', 'num_5'));
      update ops.slots set reservation = 'smuggled' where (true`;
    const { status, output } = drill(
      withPlanted([{ ...MARKS, changes: [{ ...MARKS.changes![0]!, where: smuggled }] }]),
    );
    expect(status).toBe(1);
    // Refused by the server before anything was compared, not a write the drill then saw.
    expect(output).toMatch(/upgrade-drill: failed: .*SQLSTATE/u);
    expect(output).not.toMatch(/FAILED:/u);
  }, 180_000);

  it('refuses a declaration naming a table or column the database has not got', () => {
    const { status, output } = drill(
      withPlanted([{ ...MARKS, changes: [{ ...MARKS.changes![0]!, columns: ['no_such'] }] }]),
    );
    expect(status).toBe(2);
    expect(output).toMatch(/9996_planted_marks\.changes\.json/u);
  }, 180_000);
}
