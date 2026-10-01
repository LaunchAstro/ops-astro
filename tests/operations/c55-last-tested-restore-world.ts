// SPDX-License-Identifier: AGPL-3.0-only
//
// What `c55-last-tested-restore.test.ts` shares: the view it reads, the row it
// checks, a statement tried as a role, and the drill run as an admitted
// operator with its restore and its store stood in, writing the date with the
// real writer (scripts/ops/tested-restore.ts) on the world's own database.

import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Harness } from '../acceptance/role-case-harness.ts';
import { bearer, call, personPath, serverUrl, type Answer } from '../acceptance/world.ts';
import { pathOf } from './c55-operations-world.ts';

export const DRILL_ROLE = 'ops_astro_restore_drill';
export const APP_GROUP = 'ops_astro_app';
export const TABLE = 'ops.last_tested_restore';
export const WRITE = 'select ops.record_tested_restore()';

/** The window the store's restore heartbeat uses, read from the store's own one row. */
export const RESTORE_DAYS: number = Number(
  /values \(\d+, (\d+), /u.exec(readFileSync('deploy/staging/backup-store.sql', 'utf8'))?.[1],
);

export type Shown = { readonly at: string | null; readonly stale: boolean } | undefined;

export const view = async (
  harness: Harness,
  token: string = harness.world.ada.token,
): Promise<Answer> =>
  await call(
    harness.world.api,
    personPath('alpha', pathOf('operations.read')),
    { operationId: `c55-${randomUUID()}` },
    bearer(token),
  );

export const shown = async (harness: Harness): Promise<Shown> =>
  (await view(harness)).body['lastTestedRestore'] as Shown;

/** This world's database, as the owner reaches it: the drill's DATABASE_ADMIN_URL. */
const adminUrl = (harness: Harness): string => {
  const url = new URL(serverUrl ?? '');
  url.pathname = `/${harness.world.db.name}`;
  return url.toString();
};

/** The stamped row, its time as the API writes one (ISO 8601, milliseconds, UTC). */
export const stamped = async (harness: Harness): Promise<readonly { at: string }[]> =>
  await harness.world.db.admin.execute<{ at: string }>(
    `select to_char(at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as at from ${TABLE}`,
  );

class Rollback extends Error {}

/** `text` as `role`, rolled back whatever it did: 'ok' or the server's SQLSTATE. */
export const attempt = async (harness: Harness, role: string, text: string): Promise<string> => {
  try {
    await harness.world.db.admin.transaction(async (execute) => {
      await execute(`set local role ${role}`);
      await execute(text);
      throw new Rollback();
    });
  } catch (error) {
    if (error instanceof Rollback) return 'ok';
    return String((error as { code?: unknown }).code);
  }
  return 'committed';
};

type Drill = { drillAsOperator: (options: Record<string, unknown>) => Promise<unknown> };
type Writer = { recordTestedRestore?: (url: string) => Promise<string> };

/** A drill's result, standing in for the restore itself (drill-restore.mjs). */
const result = (outcome: 'passed' | 'failed') => ({
  event: 'restore drill',
  at: new Date().toISOString(),
  outcome,
  stage: outcome === 'passed' ? null : 'restore',
  productionMajor: 17,
  sourceMajor: 17,
  targetMajor: 17,
  archiveTakenAt: new Date().toISOString(),
  tables: 3,
  readAs: 'tenancy role',
  timings: {},
});

/**
 * The drill as the operator the gate admitted runs it (drill-acts.mjs), with
 * the restore stood in by `outcome` and the store by `store`; the gate writes
 * the date with the real writer on this world.
 */
export async function drill(
  harness: Harness,
  outcome: 'passed' | 'failed',
  store: () => Promise<string>,
): Promise<void> {
  const acts = '../../scripts/ops/restore-drill.mjs';
  const { drillAsOperator } = (await import(
    /* @vite-ignore */
    acts
  )) as Drill;
  const gateModule = '../../scripts/ops/tested-restore.ts';
  const writer = (await import(
    /* @vite-ignore */
    gateModule
  )) as Writer;
  const records = mkdtempSync(join(tmpdir(), 'c55-ltr-'));
  const gate = {
    ok: true,
    operator: { personId: randomUUID(), business: 'made-up' },
    records,
    recordSignIn: () => Promise.resolve(),
    recordTestedRestore: async () => await writer.recordTestedRestore?.(adminUrl(harness)),
  };
  try {
    await drillAsOperator({
      gate,
      storeUrl: 'postgres://store.invalid/backups',
      privateKey: 'unused',
      scope: {},
      reach: store,
      drill: () => Promise.resolve(result(outcome)),
    });
  } finally {
    rmSync(records, { recursive: true, force: true });
  }
}

/** The store's answer to a recorded drill: its time for a pass, nothing for a failure. */
export const storeTook =
  (outcome: 'passed' | 'failed'): (() => Promise<string>) =>
  (): Promise<string> =>
    Promise.resolve(outcome === 'passed' ? JSON.stringify(new Date().toISOString()) : '');

/** A store that took nothing: the drill's receipt was never written. */
export const storeRefused = (): Promise<string> =>
  Promise.reject(new Error('the store did not answer'));
