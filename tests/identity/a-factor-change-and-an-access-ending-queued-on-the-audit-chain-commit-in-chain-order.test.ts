// SPDX-License-Identifier: AGPL-3.0-only
//
// A factor act's record step asks the caller's standing after it holds the
// business's audit chain, and `access.end` writes its own event on that chain
// before it commits. A fixture holds the chain; the act's record step and an
// access ending of the same person in the same business both queue on it, in
// a chosen order, each on its own connection; then the fixture lets go. The one
// first in the queue commits first, and the other answers as it would on the
// next call: an act first is applied and the ending commits after it; an ending
// first refuses the act `AUTH_ACCESS_ENDED` and leaves its factor as it was.
// Neither deadlocks.

import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, beforeAll, expect, it as vitestIt } from 'vitest';
import { executeCommand } from '../../packages/core-commands/src/commands/envelope.ts';
import type { FactorProvider } from '../../packages/core-commands/src/commands/account-factor-provider.ts';
import { liveFactor } from '../../packages/core-records/src/identity/second-factor.ts';
import {
  advisoryLock,
  connect,
  type BusinessId,
} from '../../packages/core-records/src/tenancy/database.ts';
import { enrol, grantTo, installSpine, WHOLE_BUSINESS, type Member } from '../commands/fixture.ts';
import {
  createFreshDatabase,
  databaseUrlFromEnvironment,
  type FreshDatabase,
} from '../support/fresh-database.ts';
import { gate, hold, type Held } from '../support/lock-waits.ts';
import { insertBusiness } from './fixture.ts';
import { ACTS, factorCaller, provider } from './factor-lock-wait-fixture.ts';

const it = databaseUrlFromEnvironment() === undefined ? vitestIt.skip : vitestIt;

let db: FreshDatabase;
let business: BusinessId;
let ada: Member;
beforeAll(async () => {
  if (databaseUrlFromEnvironment() === undefined) return;
  db = await createFreshDatabase({ part: 'factorchainend' });
  business = (await insertBusiness(db.app, 'factor-chain-end')) as BusinessId;
  await installSpine(db.app, business);
  ada = await enrol(db.app, business, 'Ada Lane');
  await db.app.withBusiness(business, async (tx) => {
    await grantTo(tx, ada, 'manage', WHOLE_BUSINESS, false, 'access');
  });
}, 180_000);
afterAll(async () => {
  await db?.drop();
});

/** A backend, none of `except`, waiting on a lock that one of `holders` holds or queues ahead for. */
async function blockedBy(
  holders: readonly number[],
  except: readonly number[] = [],
): Promise<number> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    // oxlint-disable-next-line no-await-in-loop -- polls, one look at a time
    const rows = await db.admin.execute<{ readonly pid: number }>(
      `select pid from pg_stat_activity
        where datname = current_database() and pg_blocking_pids(pid) && $1::int[]
          and not (pid = any($2::int[]))`,
      [holders, except],
    );
    if (rows[0] !== undefined) return rows[0].pid;
    // oxlint-disable-next-line no-await-in-loop -- polls, one look at a time
    await delay(10);
  }
  throw new Error(`nothing waited behind ${holders.join(', ')}`);
}

/** Where an event stands in the chain: the latest of `command` by `actor`, or of `operation`. */
async function place(where: 'operation_id' | 'actor_id', value: string, command: string) {
  const [row] = await db.admin.execute<{ readonly seq: number; readonly outcome: string }>(
    `select seq::int as seq, outcome from public.audit_events
      where business_id = $1 and ${where}::text = $2 and command = $3
      order by seq desc limit 1`,
    [business, value, command],
  );
  return row;
}

/** The provider, its first call held until `go`, so the act's first transaction has committed. */
function gated(act: 'enrol' | 'remove', removed: string[]) {
  const reached = gate();
  const go = gate();
  const answering = provider(removed);
  const call = act === 'enrol' ? 'enrol' : 'verify';
  const to: FactorProvider = {
    ...answering,
    [call]: async (...args: never[]) => {
      reached.release();
      await go.promise;
      return await (answering[call] as (...a: never[]) => Promise<unknown>)(...args);
    },
  };
  return { to, reached, go };
}

/** The business's audit chain, held by a fixture whose backend is named. */
async function chainHeld(): Promise<{ readonly chain: Held; readonly fixture: number }> {
  let fixture = 0;
  const chain = await hold(db.appUrl, business, async (tx) => {
    const [row] = await tx.query<{ readonly pid: number }>('select pg_backend_pid() as pid');
    fixture = row?.pid ?? 0;
    await advisoryLock(tx, business.toLowerCase());
  });
  return { chain, fixture };
}

/** What the act and the ending left, the act's event placed against the ending's. */
async function left(act: string, person: string, operationId: string) {
  const [owner] = await db.admin.execute<{ readonly id: string }>(
    `select id::text from public.actors where business_id = $1 and person_id = $2::uuid`,
    [business, person],
  );
  const actEvent = await place('actor_id', owner?.id ?? '', `account.factor_${act}`);
  const endEvent = await place('operation_id', operationId, 'access.end');
  const live = await db.app.withBusiness(business, (tx) => liveFactor(tx, person));
  return {
    actOutcome: actEvent?.outcome,
    actBeforeEnding: (actEvent?.seq ?? 0) < (endEvent?.seq ?? 0),
    status: live?.status ?? 'none',
  };
}

/** A refusal's code, or `answered`. */
const answered = (answer: unknown): string =>
  (answer as { readonly refused?: boolean; readonly code?: string }).refused === true
    ? (answer as { readonly code: string }).code
    : 'answered';

it.each([
  ['enrol', 'the act'],
  ['remove', 'the act'],
  ['enrol', 'the ending'],
  ['remove', 'the ending'],
] as const)(
  'a factor %s and an access ending of its caller, queued on the audit chain with %s first, commit in that order',
  async (act, first) => {
    const { caller: asked, person } = await factorCaller(db, business, act === 'remove');
    const removed: string[] = [];
    const { to, reached, go } = gated(act, removed);
    const actor = connect(db.appUrl);
    const other = connect(db.appUrl);
    const operationId = randomUUID();
    const body = { command: 'access.end', operationId, holderId: person };
    let ending: Promise<unknown> | undefined;
    try {
      const acting = ACTS[act]({ ...asked, database: actor }, to);
      await reached.promise;
      const { chain, fixture } = await chainHeld();
      const endAccess = () =>
        (ending = executeCommand(other, business, ada.presented, 'api', body as never));
      try {
        if (first === 'the ending') {
          endAccess();
          const endPid = await blockedBy([fixture]);
          go.release();
          await blockedBy([fixture, endPid], [endPid]);
        } else {
          go.release();
          const actPid = await blockedBy([fixture]);
          endAccess();
          await blockedBy([fixture, actPid], [actPid]);
        }
      } finally {
        go.release();
        await chain.letGo();
      }
      const answers = { act: answered(await acting), ending: answered(await ending) };
      const actFirst = first === 'the act';
      expect({ ...answers, removed: removed.length }).toMatchObject({
        act: actFirst ? 'answered' : 'AUTH_ACCESS_ENDED',
        ending: 'answered',
        removed: act === 'remove' && actFirst ? 1 : 0,
      });
      expect(await left(act, person, operationId)).toEqual({
        actOutcome: actFirst ? 'applied' : 'refused',
        actBeforeEnding: actFirst,
        status: { enrol: actFirst ? 'unverified' : 'none', remove: actFirst ? 'none' : 'verified' }[
          act
        ],
      });
    } finally {
      go.release();
      await Promise.all([actor.close(), other.close()]);
    }
  },
);
