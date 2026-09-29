// SPDX-License-Identifier: AGPL-3.0-only
//
// S0-3d: the backup store's `S0-3 drill receipt`.
//
// S0-3 (S0-3d). The shared fixture is backup-identity.fixture.ts.

import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  serverUrl,
  BACKUP,
  RETENTION,
  RESTORE,
  keys,
  asRole,
  attempt,
  store,
  backupLogin,
  retentionLogin,
  restoreLogin,
  backupStoreHooks,
} from './backup-identity.fixture.ts';

describe.skipIf(serverUrl === undefined)('the backup store', () => {
  backupStoreHooks();

  theBackupStoreCases4();
});

const operator = randomUUID();

const passed = {
  outcome: 'passed',
  stage: null,
  target: 'throwaway container',
  productionMajor: 17,
  sourceMajor: 17,
  targetMajor: 17,
  archiveTakenAt: '2026-09-29T02:00:00.000Z',
  tables: 12,
  readAs: 'ops_astro_app',
  timings: { fetch: 10, open: 20, start: 900, restore: 400, check: 30 },
};

const failed = {
  ...passed,
  outcome: 'failed',
  stage: 'restore',
  sourceMajor: null,
  tables: null,
  readAs: null,
};

const call = (r: typeof passed | typeof failed) =>
  [
    'select backups.record_drill($1, $2, $3, $4, $5, $6, $7, $8, $9)::text as last',
    [
      r.outcome,
      r.stage,
      operator,
      r.archiveTakenAt,
      r.productionMajor,
      r.sourceMajor,
      r.targetMajor,
      r.tables,
      r.timings,
    ],
  ] as [string, unknown[]];

function theBackupStoreCases4() {
  describe('S0-3 drill receipt', () => {
    drillReceiptCases1();
    drillReceiptCases2();
    drillReceiptCases3();
    drillReceiptCases4();
  });
}

function drillReceiptCases1() {
  it('a failed drill before any passed one is recorded, and names no last tested restore', async () => {
    const path = '../../scripts/ops/restore-drill.mjs';
    const { recordDrill } = (await import(/* @vite-ignore */ path)) as {
      recordDrill: (url: string, who: string, r: Record<string, unknown>) => Promise<unknown>;
    };
    expect(await recordDrill(restoreLogin.url, operator, failed)).toBeNull();
    const [row] = await store.admin.execute<{ n: number }>(
      `select count(*)::int as n from backups.drills where outcome = 'failed'`,
    );
    expect(row?.n).toBe(1);
  });
}

function drillReceiptCases2() {
  it('only the restore identity records a drill, and a receipt is never changed or removed', async () => {
    for (const [login, role] of [
      [backupLogin, BACKUP],
      [retentionLogin, RETENTION],
    ] as const) {
      // oxlint-disable-next-line no-await-in-loop
      const client = await asRole(login.url, role);
      try {
        // oxlint-disable-next-line no-await-in-loop
        expect(await attempt(client, ...call(passed)), role).toBe('42501');
      } finally {
        // oxlint-disable-next-line no-await-in-loop
        await client.end();
      }
    }
    const reader = await asRole(restoreLogin.url, RESTORE);
    try {
      for (const text of [
        'select * from backups.drills',
        'update backups.drills set outcome = outcome',
        'delete from backups.drills',
        `insert into backups.drills (outcome, operator, production_major, timings) values ('passed', gen_random_uuid(), 17, '{}')`,
      ]) {
        // oxlint-disable-next-line no-await-in-loop
        expect(await attempt(reader, text), text).toBe('42501');
      }
      // A passed drill with a field missing is not a passed drill.
      const [text, values] = call(passed);
      expect(await attempt(reader, text, values.with(5, null))).toBe('23514');
      expect(await attempt(reader, text, values.with(4, 18))).toBe('23514');
      // Timings are stage names and milliseconds, and nothing else. Each is
      // sent as the drill sends it (`sql.json`), so none is a jsonb string
      // refused for its type alone; the last is that string.
      for (const timings of [
        { fetch: 'made-up record text' },
        { note: 4 },
        [1, 2],
        { open: { x: 1 } },
        'made-up record text',
      ]) {
        const label = JSON.stringify(timings);
        // oxlint-disable-next-line no-await-in-loop
        expect(await attempt(reader, text, values.with(8, timings)), label).toBe('23514');
      }
    } finally {
      await reader.end();
    }
    for (const text of [
      'update backups.drills set outcome = outcome',
      'delete from backups.drills',
      'truncate backups.drills',
    ]) {
      // oxlint-disable-next-line no-await-in-loop
      await expect(store.admin.execute(text), text).rejects.toThrow(/append-only/u);
    }
  });
}

function drillReceiptCases3() {
  it('a passed drill answers its own date as the last tested restore; a failed one answers the last passed', async () => {
    const reader = await asRole(restoreLogin.url, RESTORE);
    try {
      const first = await reader.query<{ last: string }>(...call(passed));
      const last = first.rows[0]?.last ?? '';
      expect(Date.parse(last)).toBeGreaterThan(Date.now() - 60_000);
      const second = await reader.query<{ last: string }>(...call(failed));
      expect(second.rows[0]?.last).toBe(last);
    } finally {
      await reader.end();
    }
    const rows = await store.admin.execute<{
      outcome: string;
      stage: string | null;
      actor: string;
    }>('select outcome, stage, actor from backups.drills order by id');
    expect(rows.slice(-2)).toStrictEqual([
      { outcome: 'passed', stage: null, actor: restoreLogin.name },
      { outcome: 'failed', stage: 'restore', actor: restoreLogin.name },
    ]);
  });
}

function drillReceiptCases4() {
  it('the operator receipt has every field and no other, and carries no key, credential, path or record data', async () => {
    const path = '../../scripts/ops/restore-drill.mjs';
    const drillModule = (await import(/* @vite-ignore */ path)) as {
      drillAsOperator: (options: Record<string, unknown>) => Promise<unknown>;
      RECEIPT_FIELDS: readonly string[];
    };
    const records = mkdtempSync(join(tmpdir(), 's0-3d-'));
    const canary = `canary-${randomBytes(8).toString('hex')}`;
    try {
      const gate = {
        ok: true as const,
        operator: { personId: operator, business: 'made-up' },
        records,
        recordSignIn: async () => {},
      };
      for (const outcome of [passed, failed]) {
        // oxlint-disable-next-line no-await-in-loop
        const receipt = (await drillModule.drillAsOperator({
          gate,
          storeUrl: restoreLogin.url,
          drill: async () => ({
            event: 'restore drill',
            at: new Date().toISOString(),
            ...outcome,
          }),
        })) as Record<string, unknown>;
        expect(Object.keys(receipt).toSorted()).toStrictEqual(
          [...drillModule.RECEIPT_FIELDS].toSorted(),
        );
        expect(receipt).toMatchObject({
          action: 'restore drill recorded',
          outcome: outcome.outcome,
          operator,
          productionMajor: 17,
          targetMajor: 17,
        });
        expect(typeof receipt['lastTestedRestore']).toBe('string');
        const text = JSON.stringify(receipt);
        for (const secret of [
          restoreLogin.url,
          restoreLogin.name,
          records,
          keys.privateKey,
          canary,
        ]) {
          expect(text).not.toContain(secret);
        }
        expect(text).not.toMatch(/PRIVATE KEY|postgres:\/\/|\/Users\/|\/tmp\/|sha256/u);
      }
      const kept = readFileSync(join(records, 'deployments.jsonl'), 'utf8').trim().split('\n');
      expect(kept).toHaveLength(2);
      expect(kept.map((line) => (JSON.parse(line) as { action: string }).action)).toStrictEqual([
        'restore drill recorded',
        'restore drill recorded',
      ]);
    } finally {
      rmSync(records, { recursive: true, force: true });
    }
  });
}
