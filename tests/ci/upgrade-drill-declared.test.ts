// SPDX-License-Identifier: AGPL-3.0-only
//
// S0-3 upgrade drill, declared changes (ORCH47 ruling on SL08's ASK, 1 Oct 2026).
//
// A migration that changes existing rows on purpose (a slot reservation, a
// field's owners) says so in `migrations/<version>.changes.json`, beside the
// file: the table, the columns and a row predicate. The drill excuses a row
// only where all three hold, and it fails a declaration whose change never
// happened, so a declaration cannot become a standing hole in the check. These
// cases plant migrations after the head that do what 0131, 0132, 0133 and 0141
// of the SL07/SL08 stack do.

import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';

const serverUrl = databaseUrlFromEnvironment();
const scratch: string[] = [];

interface Declaration {
  readonly table: string;
  readonly columns: readonly string[];
  readonly where: string;
}

interface Planted {
  readonly version: string;
  readonly sql: string;
  readonly changes?: readonly Declaration[];
}

/** The real migrations, plus the planted ones after the head, each with its declaration if any. */
function withPlanted(planted: readonly Planted[]): string {
  const directory = mkdtempSync(join(tmpdir(), 'upgrade-drill-declared-'));
  scratch.push(directory);
  for (const file of readdirSync('migrations')) {
    if (file.endsWith('.sql')) copyFileSync(join('migrations', file), join(directory, file));
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

function drill(directory: string): {
  status: number | null;
  output: string;
  result: DrillResult | undefined;
} {
  const run = spawnSync(
    process.execPath,
    ['scripts/local/upgrade-drill.mjs', '--from', '0041', '--migrations', directory, '--json'],
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

const MARKS: Planted = {
  version: '9996_planted_marks',
  sql: `update ops.slots set reservation = 'task_spine' where slot in ('num_3', 'num_4', 'num_5')`,
  changes: [
    {
      table: 'ops.slots',
      columns: ['reservation'],
      where: `slot in ('num_3', 'num_4', 'num_5')`,
    },
  ],
};
const AD_HOC: Planted = {
  version: '9997_planted_adhoc',
  sql: `update ops.slots set reservation = 'task_spine' where slot = 'bool_2'`,
  changes: [{ table: 'ops.slots', columns: ['reservation'], where: `slot = 'bool_2'` }],
};
const COMMENT_OWNERS: Planted = {
  version: '9998_planted_comment_owners',
  sql: `update public.field_defs f set owning_operation = array['task.comment', 'task.edit_comment']
          from public.record_types t
         where t.business_id = f.business_id and t.id = f.record_type_id
           and t.key = 'task_comment' and f.key = 'body' and f.origin = 'core'
           and f.owning_operation = array['task.comment']`,
  changes: [
    {
      table: 'public.field_defs',
      columns: ['owning_operation'],
      where: `key = 'body' and origin = 'core' and record_type_id in
                (select id from public.record_types where key = 'task_comment')`,
    },
  ],
};
const STATE_OWNERS: Planted = {
  version: '9999_planted_state_owners',
  sql: `update public.field_defs f
           set owning_operation = array['task.complete', 'task.reopen', 'task.set_state', 'task.start']
          from public.record_types t
         where t.business_id = f.business_id and t.id = f.record_type_id
           and t.key = 'task' and f.key = 'state' and f.origin = 'core'
           and f.owning_operation = array['task.complete', 'task.reopen', 'task.start']`,
  changes: [
    {
      table: 'public.field_defs',
      columns: ['owning_operation'],
      where: `key = 'state' and origin = 'core' and record_type_id in
                (select id from public.record_types where key = 'task')`,
    },
  ],
};

describe.skipIf(serverUrl === undefined)('S0-3 upgrade drill, declared changes', () => {
  declaredCases1();
  declaredCases2();
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
