// SPDX-License-Identifier: AGPL-3.0-only
//
// The operator gate's hold (operator-runtime.ts, `holdingGrant`) against the
// three things a hold must survive: its own transaction ending under it, its
// process stalling past the server's bound, and other writers taking the same
// rows in another order. Every change is tried on a connection of its own.

import { randomUUID } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, describe, expect, it } from 'vitest';
import { issueGrant, revokeGrant } from '../../packages/core-records/src/authority/grants.ts';
import { lockAccess } from '../../packages/core-records/src/authority/access.ts';
import { subjectKey } from '../../packages/core-records/src/identity/ending-keys.ts';
import {
  connectAsAdmin,
  type TenantQuery,
} from '../../packages/core-records/src/tenancy/database.ts';
import {
  RECORD_FILE,
  recordDeployment,
  requireOperatingOperator,
  type Gate,
} from '../../scripts/ops/operator.ts';
import { signBearer } from '../support/sign-in.ts';
import type { FreshDatabase } from '../support/fresh-database.ts';
import {
  insertActor,
  insertLogin,
  insertMapping,
  insertMembership,
  insertPerson,
} from '../identity/fixture.ts';
import {
  adminUrl,
  environment,
  ISSUER,
  operatorOnlyHooks,
  serverUrl,
} from './operator-only.fixture.ts';
import { manager, marks, scratch } from './operator-only-commands.fixture.ts';

let db: FreshDatabase;
let business = '';
type Held = Extract<Gate, { ok: true }>;

const inBusiness = async <T>(run: (tx: TenantQuery) => Promise<T>): Promise<T> =>
  await db.app.withBusiness(business, run);

/** A person of the operating business holding `operations:manage` over all of it. */
async function admittedOperator() {
  return await inBusiness(async (tx) => {
    const subject = `hold-${randomUUID()}`;
    const personId = await insertPerson(tx, 'Hollis');
    const actorId = await insertActor(tx, personId);
    await insertMembership(tx, personId);
    const loginId = await insertLogin(tx, subject);
    const mappingId = await insertMapping(tx, loginId, personId, actorId);
    const issued = await issueGrant(tx, [{ kind: 'actor', id: actorId }], {
      subject: { kind: 'person', id: personId },
      scope: { kind: 'business', id: null },
      collection: 'operations',
      action: 'manage',
      parentGrantId: null,
      grantedByActorId: actorId,
    });
    if (!issued.ok) throw new Error('fixture grant refused');
    return { subject, personId, loginId, mappingId, grantId: issued.value };
  });
}

async function gateFor(subject: string): Promise<Held> {
  const env = environment(marks(manager(false)), process.env['PATH'] ?? '', {
    OPS_ASTRO_TOKEN: await signBearer({
      sub: subject,
      iss: ISSUER,
      aud: 'authenticated',
      role: 'authenticated',
      session_id: randomUUID(),
      exp: Math.floor(Date.now() / 1000) + 600,
    }),
  });
  const gate = await requireOperatingOperator(env);
  if (!gate.ok) throw new Error(`fixture operator was not admitted: ${gate.reason}`);
  return gate;
}

type Operator = Awaited<ReturnType<typeof admittedOperator>>;
const ENDED = /no longer holds operations:manage/u;
const ACT = { act: 'made-up deploy' };
const recorded = (gate: Held): boolean => existsSync(join(gate.records, RECORD_FILE));

/** The backend in this database whose activity matches `where`, once there is one. */
async function backendWhere(where: string): Promise<number> {
  for (let tries = 0; tries < 400; tries += 1) {
    // eslint-disable-next-line no-await-in-loop -- polling the server, one look at a time
    const [row] = await db.admin.execute<{ pid: number }>(
      `select pid from pg_stat_activity
        where datname = current_database() and pid <> pg_backend_pid() and ${where}`,
    );
    if (row !== undefined) return row.pid;
    // eslint-disable-next-line no-await-in-loop -- polling the server, one look at a time
    await sleep(25);
  }
  throw new Error(`no backend matched: ${where}`);
}

interface Blocker {
  readonly taken: Promise<void>;
  readonly letGo: () => Promise<void>;
}

/** A transaction on an admin connection of its own that runs `take`, then holds until `letGo`. */
function holding(take: string, parameters: readonly unknown[]): Blocker {
  let [onTaken, onLetGo] = [(): void => {}, (): void => {}];
  const taken = new Promise<void>((resolve) => {
    onTaken = resolve;
  });
  const go = new Promise<void>((resolve) => {
    onLetGo = resolve;
  });
  const own = connectAsAdmin(adminUrl());
  const done = own
    .transaction(async (execute) => {
      await execute(take, parameters);
      onTaken();
      await go;
    })
    .finally(async () => await own.close());
  return {
    taken,
    letGo: async () => {
      onLetGo();
      await done;
    },
  };
}

// The hold: idle in its transaction, holding the session's ending keys shared.
const HOLD_IDLE = `state like 'idle in transaction%' and pid in (
  select pid from pg_locks where locktype = 'advisory' and mode = 'ShareLock' and granted)`;
const SIGN_IN_WAITING = `wait_event_type = 'Lock' and query like '%insert into public.authentication_attempts%'`;
const LOGIN_ROWS_WAITING = `wait_event_type = 'Lock' and query like '%public.person_logins%for share%'`;
const REVOKE_WAITING = `wait_event_type = 'Lock' and query like '%update public.grants set revoked_at%'`;
// The removal waits at the access key, or, with the hold not taking it, at the revocation.
const REMOVAL_WAITING = `wait_event_type = 'Lock' and (query like '%pg_advisory_xact_lock(%'
  or query like '%update public.grants set revoked_at%')`;

async function endedTransactionRecordsNothing(): Promise<void> {
  const held = await admittedOperator();
  const gate = await gateFor(held.subject);
  // The sign-in record's insert waits here, so the hold is held while it does.
  const table = holding('lock table public.authentication_attempts in share mode', []);
  await table.taken;
  const deployed = recordDeployment(gate, ACT).catch((error: unknown) => error);
  try {
    await endUnderTheHold(held);
  } finally {
    await table.letGo();
  }
  await deployed;
  expect(recorded(gate)).toBe(false);
}

async function endUnderTheHold(held: Operator): Promise<void> {
  await backendWhere(SIGN_IN_WAITING);
  // The hold's transaction ends under it (the server's idle bound, a restart, a dropped link).
  const hold = await backendWhere(HOLD_IDLE);
  await db.admin.execute('select pg_terminate_backend($1)', [hold]);
  // Nothing holds the grant now: its revocation commits at once.
  const revoked = await inBusiness(async (tx) => {
    await tx.query("set local lock_timeout = '2s'");
    return await revokeGrant(tx, held.grantId);
  });
  expect(revoked).toBeInstanceOf(Date);
}

async function stalledReleaseRefused(): Promise<void> {
  const held = await admittedOperator();
  const gate = await gateFor(held.subject);
  let [answer]: [(outcome: string) => void] = [(): void => {}];
  const released = new Promise<string>((resolve) => {
    answer = resolve;
  });
  // Not awaited: a hold whose connection the server ended may never settle.
  void gate
    .holdingGrant(async (release) => {
      // The process stalls past the budget and the server's bound a second
      // after it (a pause, a swap storm, a stopped process): no timer runs.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2_500);
      try {
        release();
        answer('released');
      } catch (error) {
        answer(ENDED.test(String(error)) ? 'refused' : 'threw otherwise');
      }
      return await released;
    }, 1_000)
    .catch(() => null);
  expect(await released).toBe('refused');
}

/** A hold that releases as soon as it is held, settled either way. */
const heldBriefly = async (gate: Held, budgetMs: number): Promise<unknown> =>
  await gate
    .holdingGrant(async (release) => await Promise.resolve(release()), budgetMs)
    .catch((error: unknown) => error);

async function revocationBoundedByBudget(): Promise<void> {
  const held = await admittedOperator();
  const gate = await gateFor(held.subject);
  // The hold's lock waits meet two writers in turn: the mapping row, the ending key.
  const mapping = holding('select 1 from public.person_logins where id = $1 for update', [
    held.mappingId,
  ]);
  const ending = holding('select pg_advisory_xact_lock(hashtextextended($1, 0))', [
    subjectKey(held.subject),
  ]);
  await Promise.all([mapping.taken, ending.taken]);
  const hold = heldBriefly(gate, 1_000);
  let waited = 0;
  try {
    await backendWhere(LOGIN_ROWS_WAITING);
    const started = Date.now();
    // Timed when it commits, not when the blockers below are let go.
    const revocation = inBusiness(async (tx) => await revokeGrant(tx, held.grantId)).then(
      () => Date.now() - started,
    );
    await backendWhere(REVOKE_WAITING);
    await sleep(1_600);
    await mapping.letGo();
    await sleep(1_600);
    await ending.letGo();
    waited = await revocation;
  } finally {
    await Promise.all([mapping.letGo(), ending.letGo()]);
  }
  await hold;
  // The budget, and the server's bound a second past it, with a little slack.
  expect(waited).toBeLessThanOrEqual(2_300);
}

async function personRemovalNotDeadlocked(): Promise<void> {
  const held = await admittedOperator();
  const gate = await gateFor(held.subject);
  // Something holds the login's row a moment, so the hold waits there with
  // the grant chain already share-locked.
  const login = holding('select 1 from public.logins where id = $1 for update', [held.loginId]);
  await login.taken;
  const hold = heldBriefly(gate, 10_000);
  let removal: Promise<unknown> = Promise.resolve();
  try {
    await backendWhere(`wait_event_type = 'Lock' and query like '%public.logins%for share%'`);
    // Ending the person's access in access-end.ts's order: the access key,
    // the membership row for update, then their grants revoked.
    removal = inBusiness(async (tx) => {
      await lockAccess(tx);
      await tx.query(
        `select id from public.memberships
          where business_id = $1 and person_id = $2::uuid and active
          for update`,
        [tx.businessId, held.personId],
      );
      return await revokeGrant(tx, held.grantId);
    }).catch((error: unknown) => ({ code: (error as { code?: unknown }).code }));
    await backendWhere(REMOVAL_WAITING);
  } finally {
    await login.letGo();
  }
  const outcome = await removal;
  await hold;
  expect(outcome).toBeInstanceOf(Date);
}

describe.skipIf(serverUrl === undefined)("the operator gate's hold, while it lasts", () => {
  operatorOnlyHooks((state) => {
    db = state.db;
    business = state.alphaBusiness;
  });
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));

  it(
    'a hold whose transaction ended under it writes no deployment record',
    endedTransactionRecordsNothing,
  );
  it(
    "a release after the process stalled past the server's bound is refused",
    stalledReleaseRefused,
  );
  it(
    "a revocation waits no longer than the hold's budget when the hold's own lock waits run long",
    revocationBoundedByBudget,
  );
  it(
    "ending a person's access while a hold is being taken is not lost to a deadlock",
    personRemovalNotDeadlocked,
  );
});
