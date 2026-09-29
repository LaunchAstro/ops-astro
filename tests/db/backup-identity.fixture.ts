// SPDX-License-Identifier: AGPL-3.0-only
//
// The S0-3b backup suites' shared fixture (backup-identity*.test.ts and
// backup-store*.test.ts): the job and drill modules as the machine loads them,
// the identities' names, a made-up key pair, and the logins each suite makes
// and drops.

import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import postgres from 'postgres';
import { afterAll, beforeAll } from 'vitest';
import {
  createEmptyDatabase,
  createFreshDatabase,
  databaseUrlFromEnvironment,
  type EmptyDatabase,
} from '../support/fresh-database.ts';

/** How the job and the drill reach the store: a login and a script in, what psql prints out. */
export type Reach = (url: string, script: string) => Promise<string>;

/** The job as the machine runs it; loaded per test so a missing job fails its own tests only. */
export const job = async (): Promise<{
  runBackup: (options: {
    dump: () => Promise<Buffer>;
    storeUrl: string;
    publicKey?: string;
    heartbeat?: string;
    send?: (address: string | undefined) => Promise<string>;
    reach?: Reach;
  }) => Promise<Record<string, unknown>>;
  expireBackups: (options: {
    storeUrl: string;
    reach?: Reach;
    restoreHeartbeat?: string;
    send?: (address: string | undefined) => Promise<string>;
  }) => Promise<Record<string, unknown>>;
}> => {
  const path = '../../scripts/ops/backup.mjs';
  return await import(
    /* @vite-ignore */
    path
  );
};

export const serverUrl: string | undefined = databaseUrlFromEnvironment();
export const BACKUP = 'ops_astro_backup';
export const RETENTION = 'ops_astro_backup_retention';
export const RESTORE = 'ops_astro_backup_restore';
export const SUFFIX: Record<string, string> = {
  [BACKUP]: 'bk',
  [RETENTION]: 'rt',
  [RESTORE]: 'rs',
};
export const keys: { publicKey: string; privateKey: string } = generateKeyPairSync('rsa', {
  modulusLength: 3072,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
export const drill = async (): Promise<{
  fetchLatest: (storeUrl: string, reach?: Reach) => Promise<{ takenAt: string; body: Buffer }>;
  restoreDrill: (options: {
    fetchArchive: () => Promise<{ takenAt: string; body: Buffer }>;
    privateKey: string;
    scope: { business: string; client: string; person: string };
    docker: (args: string[], input?: Buffer) => Promise<{ code: number; stdout: string }>;
  }) => Promise<{ outcome: string; stage?: string }>;
}> => {
  const path = '../../scripts/ops/restore-drill.mjs';
  return await import(
    /* @vite-ignore */
    path
  );
};
export const seal = async (): Promise<{
  openArchive: (sealed: Buffer, privateKey: string) => Buffer;
  sealArchive: (dump: Buffer, publicKey: string) => Buffer;
}> => {
  const path = '../../scripts/ops/archive-seal.mjs';
  return await import(
    /* @vite-ignore */
    path
  );
};
export const read = (path: string): string =>
  readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');

if (serverUrl === undefined) {
  console.warn(
    'db/backup-identity: DATABASE_URL is unset, so nothing below ran and nothing is proved.',
  );
}

/** A login that is a member of `role` and nothing else, for this database only. */
export async function loginIn(
  db: EmptyDatabase,
  role: string,
): Promise<{ url: string; name: string }> {
  const name = `${db.name}_${SUFFIX[role] ?? 'xx'}`;
  const password = randomBytes(18).toString('base64url');
  await db.admin.execute(
    `create role "${name}" login password '${password}' nosuperuser nocreatedb nocreaterole nobypassrls noinherit in role ${role}`,
  );
  await db.admin.execute(`grant connect on database "${db.name}" to "${name}"`);
  const url = new URL(serverUrl ?? '');
  url.pathname = `/${db.name}`;
  url.username = name;
  url.password = password;
  return { url: url.toString(), name };
}

/**
 * The store reached from the machine, for the policy suites here. It runs the
 * same scripts the job and the drill send through psql on staging's network
 * (scripts/ops/backup-store-reach.mjs) over one session, and answers what
 * `psql -At` prints: each row's one value, a line each.
 */
export async function hostReach(url: string, script: string): Promise<string> {
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    const results = (await sql.unsafe(script)) as unknown as Record<string, unknown>[][];
    return results
      .flat()
      .map((row) => String(Object.values(row)[0] ?? ''))
      .join('\n');
  } finally {
    await sql.end();
  }
}

/** One session, so `set role` and `begin` hold for every statement after them. */
export class Client {
  readonly #sql: postgres.Sql;
  constructor(url: string) {
    this.#sql = postgres(url, { max: 1, onnotice: () => {} });
  }
  async query<Row = Record<string, unknown>>(
    text: string,
    values: unknown[] = [],
  ): Promise<{ rows: Row[]; rowCount: number }> {
    const result = await this.#sql.unsafe(text, values as postgres.ParameterOrJSON<never>[]);
    return { rows: [...result] as Row[], rowCount: result.count };
  }
  async end(): Promise<void> {
    await this.#sql.end();
  }
}

export async function asRole(url: string, role: string): Promise<Client> {
  const client = new Client(url);
  await client.query(`set role ${role}`);
  return client;
}

/** The SQLSTATE a statement fails with, or 'ok'. Each try is rolled back. */
export async function attempt(
  client: Client,
  text: string,
  values: unknown[] = [],
): Promise<string> {
  await client.query('begin');
  try {
    await client.query(text, values);
    return 'ok';
  } catch (error) {
    return (error as { code?: string }).code ?? 'unknown';
  } finally {
    await client.query('rollback');
  }
}

export async function dropLogins(db: EmptyDatabase | undefined, names: string[]): Promise<void> {
  if (db === undefined) return;
  const url = serverUrl ?? '';
  await db.drop();
  const cleanup = new Client(url);
  try {
    for (const name of names) {
      // oxlint-disable-next-line no-await-in-loop
      await cleanup.query(`drop role if exists "${name}"`);
    }
  } finally {
    await cleanup.end();
  }
}

export let store: EmptyDatabase;
export let backupLogin: { url: string; name: string };
export let retentionLogin: { url: string; name: string };
export let restoreLogin: { url: string; name: string };

export async function receipts(): Promise<{ action: string; archive_id: string; bytes: string }[]> {
  return [
    ...(await store.admin.execute<{ action: string; archive_id: string; bytes: string }>(
      'select action, archive_id::text, bytes::text from backups.receipts order by id',
    )),
  ];
}

export async function archiveIds(): Promise<string[]> {
  return (
    await store.admin.execute<{ id: string }>('select id::text from backups.archives order by id')
  ).map((r) => r.id);
}

/** The backup store and its three logins, made before and dropped after the calling describe. */
export function backupStoreHooks(): void {
  beforeAll(async () => {
    // The role the store grants to is made by migration 0034 on the source; one
    // cluster holds both, as staging's server does.
    const source = await createFreshDatabase({ part: 's03bsrc' });
    await source.drop();
    store = await createEmptyDatabase({ part: 's03bstore' });
    await store.admin.execute(read('deploy/staging/backup-store.sql'));
    backupLogin = await loginIn(store, BACKUP);
    retentionLogin = await loginIn(store, RETENTION);
    restoreLogin = await loginIn(store, RESTORE);
  }, 120_000);

  afterAll(async () => {
    await dropLogins(
      store,
      [backupLogin?.name, retentionLogin?.name, restoreLogin?.name].filter(
        (n): n is string => n !== undefined,
      ),
    );
    // The store made the restore role; it goes with the store, so no run leaves
    // it on a shared cluster. Another run's store still granting to it keeps it
    // (2BP01), and that run drops it.
    const cleanup = new Client(serverUrl ?? '');
    try {
      await cleanup.query(`drop role if exists ${RESTORE}`);
    } catch (error) {
      if ((error as { code?: string }).code !== '2BP01') throw error;
    } finally {
      await cleanup.end();
    }
  });
}

/** A drill receipt as the store takes it (S0-3d). */
export type DrillRecord = {
  readonly outcome: string;
  readonly stage: string | null;
  readonly target: string;
  readonly productionMajor: number;
  readonly sourceMajor: number | null;
  readonly targetMajor: number;
  readonly archiveTakenAt: string;
  readonly tables: number | null;
  readonly readAs: string | null;
  readonly timings: {
    readonly fetch: number;
    readonly open: number;
    readonly start: number;
    readonly restore: number;
    readonly check: number;
  };
};

export const operator: string = randomUUID();

export const passed: DrillRecord = {
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

export const failed: DrillRecord = {
  ...passed,
  outcome: 'failed',
  stage: 'restore',
  sourceMajor: null,
  tables: null,
  readAs: null,
};

export const call = (r: DrillRecord): [string, unknown[]] =>
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

export const address: string = 'https://heartbeat.example.test/api/push/restore';

export const expire = async (sent: string[]): Promise<Record<string, unknown>> =>
  await (
    await job()
  ).expireBackups({
    storeUrl: retentionLogin.url,
    reach: hostReach,
    restoreHeartbeat: address,
    send: (to: string | undefined) => {
      sent.push(to ?? '');
      return Promise.resolve('sent');
    },
  });

export const age = async (days: number): Promise<void> => {
  await store.admin.execute('alter table backups.drills disable trigger drills_append_only');
  try {
    await store.admin.execute(
      `update backups.drills set at = now() - make_interval(days => ${days})`,
    );
  } finally {
    await store.admin.execute('alter table backups.drills enable trigger drills_append_only');
  }
};
