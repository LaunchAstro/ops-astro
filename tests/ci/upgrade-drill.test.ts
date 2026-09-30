// SPDX-License-Identifier: AGPL-3.0-only
//
// S0-3 upgrade drill (roadmap S0-3a, checklist line C12; product issue 53).
//
// `pnpm verify:upgrade-drill` builds its own starting point: a fresh database
// migrated to a chosen older version and seeded, then upgraded to the head
// with the application stopped, then compared row for row. These cases hold
// it to that. The planted case is the one that matters: a migration that
// changes one existing row must turn the drill red, or a green drill says
// nothing about the data an installation carries through an upgrade.

import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { readMigrations } from '../../packages/core-records/src/tenancy/migrate.ts';

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn(
    'S0-3 upgrade drill: DATABASE_URL is unset, so nothing below ran and nothing is proved.',
  );
}

const onDisk = readMigrations('migrations');
const head = onDisk.at(-1)?.version ?? '';
const scratch: string[] = [];

/** The real migrations, plus one planted after the head. */
function withPlanted(name: string, sql: string): string {
  const directory = mkdtempSync(join(tmpdir(), 'upgrade-drill-'));
  scratch.push(directory);
  for (const file of readdirSync('migrations')) {
    if (file.endsWith('.sql')) copyFileSync(join('migrations', file), join(directory, file));
  }
  writeFileSync(join(directory, name), `${sql}\n`);
  return directory;
}

interface Difference {
  readonly table: string;
  readonly changedOrLost: number;
  readonly added: number;
  readonly gone: boolean;
}

interface DrillResult {
  readonly ok: boolean;
  readonly from: string;
  readonly to: string;
  readonly applied: readonly string[];
  readonly tables: number;
  readonly rows: number;
  readonly differences: readonly Difference[];
}

interface Run {
  readonly status: number | null;
  readonly output: string;
  readonly result: DrillResult | undefined;
}

/** The command itself, as CI runs it, with its one-line JSON result read back. */
function drill(from: string, migrationsDirectory?: string, json = true): Run {
  const args = ['scripts/local/upgrade-drill.mjs', '--from', from];
  if (migrationsDirectory !== undefined) args.push('--migrations', migrationsDirectory);
  if (json) args.push('--json');
  const run = spawnSync(process.execPath, args, {
    encoding: 'utf8',
    env: { ...process.env, DATABASE_ADMIN_URL: serverUrl },
  });
  const last = run.stdout.trim().split('\n').at(-1) ?? '';
  return {
    status: run.status,
    output: run.stdout + run.stderr,
    result: json && last.startsWith('{') ? (JSON.parse(last) as DrillResult) : undefined,
  };
}

afterAll(() => {
  for (const directory of scratch) rmSync(directory, { recursive: true, force: true });
});

describe.skipIf(serverUrl === undefined)('S0-3 upgrade drill', () => {
  upgradeDrillCases1();
  upgradeDrillCases2();
  upgradeDrillCases3();
});

function upgradeDrillCases1() {
  it('upgrades a database seeded at 0023 to the head with every row unchanged', () => {
    const { status, result } = drill('0023');
    expect(result?.differences).toStrictEqual([]);
    expect(result?.ok).toBe(true);
    expect(status).toBe(0);
    expect(result?.from.startsWith('0023')).toBe(true);
    expect(result?.to).toBe(head);
    expect(result?.applied).toStrictEqual(
      onDisk.map((m) => m.version).filter((version) => version > (result?.from ?? '')),
    );
    // A drill over an empty database would pass by comparing nothing.
    expect(result?.rows).toBeGreaterThan(20);
    expect(result?.tables).toBeGreaterThan(5);
  }, 180_000);

  it('turns red when a migration changes one existing row, and names the table', () => {
    const planted = withPlanted(
      '9999_planted_change.sql',
      `update public.records set data = data || '{"planted": "canary-7f3a"}'::jsonb
        where id = (select id from public.records order by id limit 1)`,
    );
    const { status, result, output } = drill('0023', planted);
    expect(status).toBe(1);
    expect(result?.ok).toBe(false);
    expect(result?.applied.at(-1)).toBe('9999_planted_change');
    // The record's derived unique-value row moves with it; the record itself is the plant.
    expect(result?.differences).toContainEqual({
      table: 'public.records',
      changedOrLost: 1,
      added: 1,
      gone: false,
    });
    // The report names tables and counts, never a row's content.
    expect(output).toMatch(/public\.records: 1 row changed or lost/u);
    expect(output).not.toMatch(/canary-7f3a/u);
  }, 180_000);
}

function upgradeDrillCases2() {
  it('turns red when a migration deletes a row, and when it drops a table', () => {
    const planted = withPlanted(
      '9999_planted_loss.sql',
      `delete from public.record_unique_values;
       drop table public.record_links`,
    );
    const { status, result } = drill('0023', planted);
    expect(status).toBe(1);
    const lost = result?.differences.find((d) => d.table === 'public.record_unique_values');
    expect(lost?.changedOrLost).toBeGreaterThan(0);
    expect(lost?.added).toBe(0);
    expect(result?.differences.find((d) => d.table === 'public.record_links')?.gone).toBe(true);
  }, 180_000);

  it('a migration that erases existing decisions fails the drill', () => {
    const planted = withPlanted('9999_planted_decision_loss.sql', 'truncate public.gate_decisions');
    const { status, result, output } = drill('0023', planted);
    expect(result, output).toBeDefined();
    expect(status).toBe(1);
    expect(result?.differences).toContainEqual(
      expect.objectContaining({ table: 'public.gate_decisions', gone: false }),
    );
  }, 180_000);

  it('a planted record secret never reaches drill errors', () => {
    const planted = withPlanted(
      '9999_planted_record_leak.sql',
      `do $sol$ declare leaked text;
       begin
         update public.records set data = data || '{"sol_secret":"sol-canary-record-4"}'::jsonb
          where id = (select id from public.records order by id limit 1);
         select data ->> 'sol_secret' into leaked from public.records
          where data ? 'sol_secret' limit 1;
         raise exception '%', leaked;
       end $sol$`,
    );
    const { status, output } = drill('0023', planted);
    expect(status).toBe(1);
    expect(output).not.toContain('sol-canary-record-4');
  }, 180_000);
}

function upgradeDrillCases3() {
  it('stays green when a migration only adds a column, which changes no stored value', () => {
    const planted = withPlanted(
      '9999_planted_column.sql',
      `alter table public.records add column planted_flag boolean not null default false`,
    );
    const { status, result } = drill('0023', planted);
    expect(result?.differences).toStrictEqual([]);
    expect(status).toBe(0);
  }, 180_000);

  it('refuses a starting point that is unknown or already the head, building nothing', () => {
    const unknown = drill('0999', undefined, false);
    expect(unknown.status).toBe(2);
    expect(unknown.output).toMatch(/no migration/u);
    const atHead = drill(head.slice(0, 4), undefined, false);
    expect(atHead.status).toBe(2);
    expect(atHead.output).toMatch(/nothing to upgrade/u);
  }, 60_000);
}

describe('S0-3 upgrade drill in CI', () => {
  it('runs in database conformance on a pull request that adds a migration, from the base', () => {
    const workflow = readFileSync('.github/workflows/ci.yml', 'utf8');
    const job = workflow.slice(
      workflow.indexOf('name: database conformance\n'),
      workflow.indexOf('\n  licences:'),
    );
    const step = job.slice(job.indexOf('- name: The upgrade drill'));
    expect(step).toContain("if: github.event_name == 'pull_request'");
    expect(step).toContain('git diff --name-only --diff-filter=A "$BASE_SHA" HEAD -- migrations/');
    expect(step).toContain('git ls-tree --name-only "$BASE_SHA" migrations/');
    expect(step).toContain('pnpm run verify:upgrade-drill --from');
    const { scripts } = JSON.parse(readFileSync('package.json', 'utf8')) as {
      scripts: Record<string, string>;
    };
    expect(scripts['verify:upgrade-drill']).toBe('node scripts/local/upgrade-drill.mjs');
  });
});
