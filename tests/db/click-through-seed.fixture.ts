// SPDX-License-Identifier: AGPL-3.0-only
//
// The SR-1 click-through seed's world: a fresh database, local-seed's cast on
// it, then the click-through seed run twice, each run's rows held whole.
//
// local-seed runs on import, so it runs as its own process: a copy under a
// temporary root, as tests/runtime/seed-revoke-live-lease.test.ts runs it, so
// every `.local/` file lands there. The click-through seed reads that folder
// through OPS_SEED_DIR. No signing key exists under the root, so no auth
// service is called, and GOTRUE_URL names a dead local port in case one were.

import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect } from 'vitest';
import {
  createFreshDatabase,
  databaseUrlFromEnvironment,
  type FreshDatabase,
} from '../support/fresh-database.ts';
import { executeRead } from '../../packages/core-commands/src/reads/execute.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import type { BusinessId } from '../../packages/core-records/src/tenancy/database.ts';
import type { VerifiedSubject } from '../../packages/core-records/src/identity/verified-subject.ts';

export const serverUrl: string | undefined = databaseUrlFromEnvironment();

const repo = resolve(import.meta.dirname, '../..');
export const SEED: string = join(repo, 'scripts/ops/click-through-seed.mjs');

export interface Ran {
  readonly status: number | null;
  readonly out: string;
}

export type Snapshot = Readonly<Record<string, readonly unknown[]>>;

export interface World {
  readonly db: FreshDatabase;
  readonly root: string;
  readonly business: BusinessId;
  readonly first: Ran;
  readonly second: Ran;
  readonly before: Snapshot;
  readonly after: Snapshot;
}

/** Every table the seed could write, so two runs can be compared whole. */
const TABLES: readonly string[] = (
  'records clients actors logins actor_logins grants planned_runs gates gate_decisions ' +
  'proposal_versions leases delegations attempts reservations budget_asks handback_reports operations'
).split(' ');

export function runSeed(script: string, db: FreshDatabase, local: string, confirm = false): Ran {
  const url = new URL(serverUrl ?? '');
  url.pathname = `/${db.name}`;
  const result = spawnSync(process.execPath, [script], {
    encoding: 'utf8',
    timeout: 240_000,
    env: {
      PATH: process.env['PATH'] ?? '',
      DATABASE_URL: db.appUrl,
      DATABASE_ADMIN_URL: url.toString(),
      OPS_SEED_DIR: local,
      GOTRUE_URL: 'http://127.0.0.1:9',
      LOCAL_SEED_MADE_UP: confirm ? 'confirm' : '',
    },
  });
  return { status: result.status, out: `${result.stdout}\n${result.stderr}` };
}

export async function snapshot(db: FreshDatabase): Promise<Snapshot> {
  const out: Record<string, readonly unknown[]> = {};
  for (const table of TABLES) {
    // One owner connection; the reads are sequential by construction.
    // oxlint-disable-next-line no-await-in-loop
    out[table] = await db.admin.execute(
      `select to_jsonb(t) as row from public.${table} t order by to_jsonb(t)::text`,
    );
  }
  return out;
}

/** local-seed's cast, then the click-through seed twice. */
export async function openWorld(): Promise<World> {
  const db = await createFreshDatabase({ part: 'sr1clickthrough' });
  const root = mkdtempSync(join(tmpdir(), 'sr1-seed-'));
  for (const dir of ['scripts', 'scripts/local', '.local']) mkdirSync(join(root, dir));
  for (const file of ['scripts/local-seed.mjs', 'scripts/local/signing-key.mjs']) {
    copyFileSync(join(repo, file), join(root, file));
  }
  for (const link of ['scripts/ops', 'packages', 'node_modules']) {
    symlinkSync(join(repo, link), join(root, link));
  }
  const local = join(root, '.local');
  const cast = runSeed(join(root, 'scripts/local-seed.mjs'), db, local, true);
  expect(cast.status, cast.out).toBe(0);
  const [row] = await db.admin.execute<{ id: string }>(
    `select id from public.businesses where key = 'alpha'`,
  );
  const first = runSeed(SEED, db, local);
  const before = await snapshot(db);
  const second = runSeed(SEED, db, local);
  const after = await snapshot(db);
  return { db, root, business: row!.id as BusinessId, first, second, before, after };
}

export async function closeWorld(world: World | undefined): Promise<void> {
  if (world === undefined) return;
  rmSync(world.root, { recursive: true, force: true });
  await world.db.drop();
}

/** Ada, the cast's admin, signed in with her second factor. */
export function ada(world: World): VerifiedSubject {
  const file = join(world.root, '.local/synthetic-users.json');
  const users = JSON.parse(readFileSync(file, 'utf8')) as { email: string; subject: string }[];
  const now = Math.floor(Date.now() / 1000);
  return {
    provider: 'supabase',
    subject: users.find((user) => user.email === 'ada@alpha.local')?.subject ?? '',
    assurance: { level: 'aal2', signedInAt: now, factorAt: now },
  };
}

/** The one task of the business with this title. */
export async function taskId(world: World, title: string): Promise<string> {
  const rows = await world.db.admin.execute<{ id: string }>(
    `select r.id from public.records r join public.record_types t on t.id = r.record_type_id
      where t.key = 'task' and r.business_id = $1 and r.txt_4 = $2`,
    [world.business, title],
  );
  expect(rows, title).toHaveLength(1);
  return rows[0]!.id;
}

export interface ReadTask {
  readonly title: string | null;
  readonly state?: { readonly machineCategory?: string } | null;
}

/** The task as Ada reads it through `task.read`. */
export async function readTask(world: World, id: string): Promise<ReadTask> {
  const read = await executeRead(world.db.app, world.business, ada(world), {
    read: 'task.read',
    recordId: id,
  } as never);
  if (isCommandRefusal(read) || !('task' in read)) throw new Error(`task.read ${id} refused`);
  return read.task as unknown as ReadTask;
}

/** The gates Ada may decide, through `gate.pending`. */
export async function pendingFor(
  world: World,
): Promise<readonly { readonly taskId: string; readonly version: number }[]> {
  const read = await executeRead(world.db.app, world.business, ada(world), {
    read: 'gate.pending',
  } as never);
  if (isCommandRefusal(read) || !('awaiting' in read)) throw new Error('gate.pending refused');
  return read.awaiting as unknown as readonly { taskId: string; version: number }[];
}

/** The runs on the task with this title, oldest first. */
export async function runsOf(
  world: World,
  title: string,
): Promise<readonly { readonly id: string; readonly state: string }[]> {
  return await world.db.admin.execute<{ id: string; state: string }>(
    'select id, state from public.planned_runs where task_id = $1 order by created_at',
    [await taskId(world, title)],
  );
}
