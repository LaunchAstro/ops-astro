// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-02's shared world: two businesses of one installation in one database,
// each with a real run a pickup made, and a pin and a ledger row seeded on it
// by the admin connection. A grant and isolation seed, never an activation:
// the plan accept that activates a file is AW-04's.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll } from 'vitest';
import { executeAgentCommand } from '../../packages/core-commands/src/commands/agent-envelope.ts';
import {
  captureManifest,
  identityOf,
  readPinned,
  type InstructionSource,
  type ReadAuditNote,
  type ReadRequest,
} from '../../packages/core-runtime/src/index.ts';
import type { TenantQuery } from '../../packages/core-records/src/index.ts';
import type { CommandResult } from '../../packages/core-commands/src/commands/register-store.ts';
import { enrol, grantTo } from '../commands/fixture.ts';
import { insertLogin } from '../identity/fixture.ts';
import {
  appliedDetail,
  approve,
  createTask,
  freshPurpose,
  liveWork,
  openSchedules,
  propose,
  seedSchedules,
  type Schedules,
  type Work,
} from './schedules-harness.ts';

export const noDatabase: boolean = process.env['DATABASE_URL'] === undefined;

export function encode(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}
export const ENTRY = 'skills/brief/SKILL.md';
export const FRAGMENT = 'skills/shared/preamble.md';
export const FILES: ReadonlyMap<string, Uint8Array> = new Map([
  [ENTRY, encode('# Brief\nWrite the brief.\n')],
  [FRAGMENT, encode('Plain words.\n')],
]);

export const STORES = [
  'public.run_definition_pins',
  'public.bootstrap_reads',
  'public.bootstrap_bytes',
] as const;

/** An in-memory source that counts what it was asked for. */
export function sourceOf(
  files: ReadonlyMap<string, Uint8Array>,
): InstructionSource & { readonly asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    read: async (path) => {
      asked.push(path);
      return await Promise.resolve(files.get(path));
    },
  };
}

export interface LeaseRow {
  readonly run_id: string;
  readonly holder_actor_id: string;
}

export async function leaseOf(owner: Schedules, leaseId: unknown): Promise<LeaseRow> {
  const rows = await owner.db.admin.execute<LeaseRow>(
    'select run_id, holder_actor_id from public.leases where id = $1',
    [leaseId],
  );
  const row = rows[0];
  if (row === undefined) throw new Error('no lease');
  return row;
}

/** A pin seeded by the admin connection on a real run: the grant test's seed. */
export async function seedPin(owner: Schedules, runId: string): Promise<void> {
  const captured = await captureManifest(sourceOf(FILES), [ENTRY, FRAGMENT]);
  if (!captured.ok) throw new Error('manifest refused');
  const entry = identityOf(ENTRY, FILES.get(ENTRY) ?? new Uint8Array());
  await owner.db.admin.execute(
    `insert into public.run_definition_pins
       (business_id, run_id, ref_kind, path, content_digest, content_size, read_at,
        manifest, manifest_digest, pinned_by_actor_id)
     values ($1, $2, 'bootstrap_file', $3, $4, $5, now(), $6::text::jsonb, $7, $8)`,
    [
      owner.business,
      runId,
      entry.path,
      entry.digest,
      entry.size,
      JSON.stringify(captured.value.entries),
      captured.value.digest,
      owner.decider.actorId,
    ],
  );
}

/** The entry read's ledger row and its audit copy, seeded beside the pin. */
export async function seedRead(owner: Schedules, runId: string): Promise<void> {
  const bytes = FILES.get(ENTRY) ?? new Uint8Array();
  const entry = identityOf(ENTRY, bytes);
  await owner.db.admin.execute(
    `insert into public.bootstrap_reads
       (business_id, id, run_id, sequence, path, content_digest, content_size, is_entry)
     values ($1, $2, $3, 1, $4, $5, $6, true)`,
    [owner.business, randomUUID(), runId, entry.path, entry.digest, entry.size],
  );
  await owner.db.admin.execute(
    `insert into public.bootstrap_bytes (business_id, content_digest, content_size, bytes)
     values ($1, $2, $3, $4)
     on conflict do nothing`,
    [owner.business, entry.digest, entry.size, Buffer.from(bytes)],
  );
}

/** The server's answer to one statement: `ok`, or the SQLSTATE it refused with. */
export async function sqlstate(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
    return 'ok';
  } catch (error) {
    return String((error as { code?: string }).code ?? error);
  }
}

/** The three stores as the owner sees them, so a refusal is shown to change nothing. */
export async function fingerprint(owner: Schedules): Promise<string> {
  const parts = await Promise.all(
    STORES.map(
      async (table) =>
        await owner.db.admin.execute<{ h: string }>(
          `select count(*)::text || ':' ||
                  md5(coalesce(string_agg(t::text, '|' order by t::text), '')) as h
             from ${table} t`,
        ),
    ),
  );
  return parts.map((rows) => rows[0]?.h ?? '').join(' ');
}

/** The pinned read in `owner`'s business, its audit notes kept in `notes`. */
export async function readAs(
  owner: Schedules,
  request: ReadRequest,
  notes: ReadAuditNote[],
  source: InstructionSource = sourceOf(FILES),
): Promise<string> {
  const answer = await owner.db.app.withBusiness(
    owner.business,
    async (tx) =>
      await readPinned(tx, request, source, async (_tx: TenantQuery, note) => {
        notes.push(note);
        await Promise.resolve();
      }),
  );
  return answer.ok ? 'read' : JSON.stringify(answer.refusal);
}

/** A same-business client: a person holding a read grant on its own task only. */
export async function clientOnItsOwnTask(owner: Schedules): Promise<string> {
  const taskX = await createTask(owner, 'aw02 client X task');
  const clientX = await enrol(owner.db.app, owner.business, 'aw02-client-x');
  await owner.db.app.withBusiness(owner.business, async (tx) => {
    await grantTo(tx, clientX, 'read', { kind: 'record', id: taskX });
  });
  return clientX.actorId;
}

/** Another person's agent, under its own live delegation, with its own lease. */
export async function anotherPersonsAgent(
  owner: Schedules,
): Promise<{ readonly leaseId: string } & LeaseRow> {
  const other = await enrol(owner.db.app, owner.business, 'aw02-other-decider');
  const subject = `agent-${randomUUID()}`;
  const agent = randomUUID();
  await owner.db.app.withBusiness(owner.business, async (tx) => {
    for (const action of ['read', 'write', 'decide', 'assign', 'comment'] as const) {
      // eslint-disable-next-line no-await-in-loop
      await grantTo(tx, other, action, undefined, true);
    }
    await tx.query(`insert into public.actors (business_id, id, kind) values ($1, $2, 'agent')`, [
      owner.business,
      agent,
    ]);
    await tx.query(
      `insert into public.actor_logins (business_id, id, login_id, actor_id, linked_by_actor_id)
       values ($1, $2, $3, $4, $5)`,
      [owner.business, randomUUID(), await insertLogin(tx, subject), agent, other.actorId],
    );
  });
  const task = await createTask(owner, 'aw02 the other agent task');
  const decision = await approve(
    owner,
    await propose(owner, task, { maximumMinor: 1_000, purpose: freshPurpose() }),
  );
  const picked = await executeAgentCommand(
    owner.db.app,
    owner.business,
    { provider: 'supabase', subject },
    undefined,
    {
      command: 'task.pickup',
      operationId: randomUUID(),
      reservationId: decision['reservationId'],
      leaseSeconds: 600,
    } as never,
  );
  const leaseId = String(appliedDetail(picked as CommandResult, 'pickup')['leaseId']);
  return { leaseId, ...(await leaseOf(owner, leaseId)) };
}

/** The world's live bindings, filled in by `useAw02World`. */
export const w = {} as {
  alpha: Schedules;
  bravo: Schedules;
  alphaWork: Work;
  bravoWork: Work;
};

/** Two businesses, a real run each, a pin and an entry read seeded on each. */
export function useAw02World(part: string): void {
  beforeAll(async () => {
    if (noDatabase) return;
    w.alpha = await openSchedules(part, 1_000_000);
    w.bravo = await seedSchedules(w.alpha.db, `${part}-bravo`, 1_000_000);
    w.alphaWork = await liveWork(w.alpha, `${part} alpha run`, 1_000);
    w.bravoWork = await liveWork(w.bravo, `${part} bravo run`, 1_000);
    for (const [owner, work] of [
      [w.alpha, w.alphaWork],
      [w.bravo, w.bravoWork],
    ] as const) {
      // eslint-disable-next-line no-await-in-loop
      const { run_id: runId } = await leaseOf(owner, work.picked['leaseId']);
      // eslint-disable-next-line no-await-in-loop
      await seedPin(owner, runId);
      // eslint-disable-next-line no-await-in-loop
      await seedRead(owner, runId);
    }
  }, 180_000);

  afterAll(async () => {
    if (noDatabase) return;
    await w.alpha.db.drop();
  });
}
