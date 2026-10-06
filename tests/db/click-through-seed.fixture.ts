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

export interface Cast {
  readonly db: FreshDatabase;
  readonly root: string;
  readonly local: string;
  readonly business: BusinessId;
}

export interface World extends Cast {
  readonly first: Ran;
  readonly second: Ran;
  readonly before: Snapshot;
  readonly after: Snapshot;
  /** The guard and mark around the first run, and bravo's rows around it. */
  readonly guards: readonly [Snapshot, Snapshot];
  readonly bravo: readonly [Snapshot, Snapshot];
}

/**
 * Every table outside the system schemas, so a write anywhere is seen. The
 * made-up guard's own schema is `guardState`'s. No table is left out: none
 * of these changes by the clock alone while the seed is not running.
 */
const TABLES = `select format('%I.%I', schemaname, tablename) as name from pg_tables
   where schemaname not in ('pg_catalog', 'information_schema', 'ops_astro_made_up')
   order by 1`;

export interface SeedOptions {
  readonly admin: FreshDatabase;
  /** The application address, when not the admin database's own. */
  readonly appUrl?: string;
  readonly local: string;
  readonly confirm?: boolean;
  readonly env?: Readonly<Record<string, string>>;
}

export function adminUrlOf(db: FreshDatabase): string {
  const url = new URL(serverUrl ?? '');
  url.pathname = `/${db.name}`;
  return url.toString();
}

export function runSeed(script: string, options: SeedOptions): Ran {
  const result = spawnSync(process.execPath, [script], {
    encoding: 'utf8',
    timeout: 240_000,
    env: {
      PATH: process.env['PATH'] ?? '',
      DATABASE_URL: options.appUrl ?? options.admin.appUrl,
      DATABASE_ADMIN_URL: adminUrlOf(options.admin),
      OPS_SEED_DIR: options.local,
      GOTRUE_URL: 'http://127.0.0.1:9',
      LOCAL_SEED_MADE_UP: options.confirm === true ? 'confirm' : '',
      ...options.env,
    },
  });
  return { status: result.status, out: `${result.stdout}\n${result.stderr}` };
}

/** Every table, whole or one business's rows. */
export async function snapshot(db: FreshDatabase, business?: string): Promise<Snapshot> {
  const out: Record<string, readonly unknown[]> = {};
  for (const { name } of await db.admin.execute<{ name: string }>(TABLES)) {
    // One owner connection; the reads are sequential by construction.
    // oxlint-disable-next-line no-await-in-loop
    out[name] = await db.admin.execute(
      `select to_jsonb(t) as row from ${name} t
        where $1::text is null or to_jsonb(t) ->> 'business_id' = $1 order by to_jsonb(t)::text`,
      [business ?? null],
    );
  }
  return out;
}

/** The made-up guard's functions, triggers, ledger and watch, and the database's mark. */
export async function guardState(db: FreshDatabase): Promise<Snapshot> {
  const read = (text: string) => db.admin.execute(text);
  return {
    functions: await read(`select p.proname, p.prosrc from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'ops_astro_made_up'
      order by 1, 2`),
    triggers: await read(`select tgrelid::regclass::text as rel, tgenabled from pg_trigger
      where tgname = 'ops_astro_made_up_guard' order by 1`),
    watch: await read('select evtname, evtenabled, evtfoid::text from pg_event_trigger order by 1'),
    ledger: await read(`select to_jsonb(l) as row from ops_astro_made_up.untrusted l
      where to_regclass('ops_astro_made_up.untrusted') is not null`).catch(() => []),
    mark: await read(`select shobj_description(oid, 'pg_database') as mark
      from pg_database where datname = current_database()`),
  };
}

/** A fresh database with local-seed's cast on it, its files under a temporary root. */
export async function openCast(part: string): Promise<Cast> {
  const db = await createFreshDatabase({ part });
  const root = mkdtempSync(join(tmpdir(), 'sr1-seed-'));
  for (const dir of ['scripts', 'scripts/local', '.local']) mkdirSync(join(root, dir));
  for (const file of ['scripts/local-seed.mjs', 'scripts/local/signing-key.mjs']) {
    copyFileSync(join(repo, file), join(root, file));
  }
  for (const link of ['scripts/ops', 'packages', 'node_modules']) {
    symlinkSync(join(repo, link), join(root, link));
  }
  const local = join(root, '.local');
  const cast = runSeed(join(root, 'scripts/local-seed.mjs'), { admin: db, local, confirm: true });
  expect(cast.status, cast.out).toBe(0);
  return { db, root, local, business: (await businessOf(db, 'alpha')) as BusinessId };
}

export async function businessOf(db: FreshDatabase, key: string): Promise<string> {
  const [row] = await db.admin.execute<{ id: string }>(
    'select id from public.businesses where key = $1',
    [key],
  );
  return row!.id;
}

/** local-seed's cast, then the click-through seed twice. */
export async function openWorld(): Promise<World> {
  const cast = await openCast('sr1clickthrough');
  const bravo = await businessOf(cast.db, 'bravo');
  const options = { admin: cast.db, local: cast.local };
  const [guarded, bravoWas] = [await guardState(cast.db), await snapshot(cast.db, bravo)];
  const first = runSeed(SEED, options);
  const before = await snapshot(cast.db);
  const guards = [guarded, await guardState(cast.db)] as const;
  const bravoRows = [bravoWas, await snapshot(cast.db, bravo)] as const;
  const second = runSeed(SEED, options);
  const after = await snapshot(cast.db);
  return { ...cast, first, second, before, after, guards, bravo: bravoRows };
}

export async function closeWorld(world: Cast | undefined): Promise<void> {
  if (world === undefined) return;
  rmSync(world.root, { recursive: true, force: true });
  await world.db.drop();
}

/** Ada, the cast's admin, signed in with her second factor. */
export function ada(world: Cast): VerifiedSubject {
  return person(world, 'ada@alpha.local');
}

/** One of the cast, by address, signed in with a second factor. */
export function person(world: Cast, email: string): VerifiedSubject {
  const file = join(world.root, '.local/synthetic-users.json');
  const users = JSON.parse(readFileSync(file, 'utf8')) as { email: string; subject: string }[];
  const now = Math.floor(Date.now() / 1000);
  return {
    provider: 'supabase',
    subject: users.find((user) => user.email === email)?.subject ?? '',
    assurance: { level: 'aal2', signedInAt: now, factorAt: now },
  };
}

/** The one task of the business with this title. */
export async function taskId(world: Cast, title: string): Promise<string> {
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
export async function readTask(world: Cast, id: string): Promise<ReadTask> {
  const read = await executeRead(world.db.app, world.business, ada(world), {
    read: 'task.read',
    recordId: id,
  } as never);
  if (isCommandRefusal(read) || !('task' in read)) throw new Error(`task.read ${id} refused`);
  return read.task as unknown as ReadTask;
}

/** The gates Ada may decide, through `gate.pending`. */
export async function pendingFor(
  world: Cast,
): Promise<readonly { readonly taskId: string; readonly version: number }[]> {
  const read = await executeRead(world.db.app, world.business, ada(world), {
    read: 'gate.pending',
  } as never);
  if (isCommandRefusal(read) || !('awaiting' in read)) throw new Error('gate.pending refused');
  return read.awaiting as unknown as readonly { taskId: string; version: number }[];
}

/** The runs on the task with this title, oldest first. */
export async function runsOf(
  world: Cast,
  title: string,
): Promise<readonly { readonly id: string; readonly state: string }[]> {
  return await world.db.admin.execute<{ id: string; state: string }>(
    'select id, state from public.planned_runs where task_id = $1 order by created_at',
    [await taskId(world, title)],
  );
}
