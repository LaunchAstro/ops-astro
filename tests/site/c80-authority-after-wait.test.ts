// SPDX-License-Identifier: AGPL-3.0-only
//
// C80's writes read their authority again after their last lock wait. A
// person's request parked on its task, an approver setting parked on its
// setting row, and a decision parked on the approver setting each lose the
// grant they were admitted on while they wait: each is refused once it gets
// through, and nothing it would have written is kept. Every case is a real
// two-connection race: the command on the app's own connection, the lock
// holder and the revoker each on a connection of their own, and the command
// is seen parked on the named row in `pg_locks` before its authority changes.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { codeOf, detailOf } from '../commands/agent-fixture.ts';
import { enrol, grantTo } from '../commands/fixture.ts';
import { issueGrant, revokeGrant } from '../../packages/core-records/src/authority/grants.ts';
import {
  awaitParked,
  holdRows,
  racer,
  waitPast,
  type Schedules,
} from '../runtime/schedules-harness.ts';
import { c80World, requestBody, type C80World } from './c80-world.ts';

const serverUrl = databaseUrlFromEnvironment();
if (serverUrl === undefined)
  console.warn('C80 authority after a wait: DATABASE_URL is unset, so nothing ran.');

const WHOLE = { kind: 'business', id: null } as const;
const APPROVER_KEY = 'live_correction_approver';

let w: C80World;
/** The harness's view of the world: its databases and its business. */
let s: Schedules;

beforeAll(async () => {
  if (serverUrl === undefined) return;
  w = await c80World('c80afterwait');
  s = { db: w.world.db, business: w.world.business } as Schedules;
}, 120_000);
afterAll(async () => {
  if (serverUrl !== undefined) await w.world.drop();
});

/** A revocation committed on a connection of its own, giving up after two seconds. */
async function revokeElsewhere(grantId: string): Promise<boolean> {
  const revoker = racer(s);
  try {
    return await revoker.withBusiness(w.world.business, async (tx) => {
      await tx.query("set local lock_timeout = '2s'");
      return (await revokeGrant(tx, grantId)) !== null;
    });
  } catch (error) {
    if (!(error instanceof postgres.PostgresError) || error.code !== '55P03') throw error;
    return false;
  } finally {
    await revoker.close();
  }
}

/** The statement each backend parked on a row lock is running. */
async function parkedStatements(): Promise<readonly string[]> {
  const found = await w.world.db.admin.execute<{ readonly query: string }>(
    `select a.query from pg_stat_activity a
      where a.datname = current_database() and a.wait_event_type = 'Lock'`,
  );
  return found.map((row) => row.query.replaceAll(/\s+/gu, ' ').trim());
}

interface Parked<T, M> {
  readonly result: T;
  /** What `meanwhile` answered while the command was parked. */
  readonly meanwhile: M;
  /** Whether the parked statement was the one named. */
  readonly parkedOn: boolean;
}

/**
 * `command` started while another connection holds `table`'s row `id`, seen
 * parked on it in a statement matching `statement`, then `meanwhile`, then the
 * row let go and the command's answer awaited.
 */
async function whileParked<T, M>(
  at: { readonly table: string; readonly id: string; readonly statement: RegExp },
  command: () => Promise<T>,
  meanwhile: () => Promise<M>,
): Promise<Parked<T, M>> {
  const holder = await holdRows(s, at.table, [at.id]);
  const running = command();
  let watched: { readonly parkedOn: boolean; readonly during: M };
  try {
    await awaitParked(s, at.table, 1);
    const parkedOn = (await parkedStatements()).some((query) => at.statement.test(query));
    watched = { parkedOn, during: await meanwhile() };
  } finally {
    await holder.release();
  }
  return { result: await running, meanwhile: watched.during, parkedOn: watched.parkedOn };
}

const correctionsBy = async (personId: string): Promise<number> =>
  Number(
    (
      await w.world.db.admin.execute<{ readonly n: string }>(
        `select count(*)::text as n from public.live_corrections
          where business_id = $1 and requested_by_person_id = $2`,
        [w.world.business, personId],
      )
    )[0]?.n,
  );

const approverSetting = async () =>
  (
    await w.world.db.admin.execute<{
      readonly id: string;
      readonly value: unknown;
      readonly revision: string;
    }>(
      `select id, value, revision::text as revision from public.business_settings
        where business_id = $1 and key = $2`,
      [w.world.business, APPROVER_KEY],
    )
  )[0];

/** A grant on gate:decide for `personId`, ending three seconds from now on the database clock. */
async function soonEndingGateGrant(personId: string, actorId: string): Promise<string> {
  return await w.world.db.app.withBusiness(w.world.business, async (tx) => {
    const [soon] = await tx.query<{ readonly at: Date }>(
      "select clock_timestamp() + interval '3 seconds' as at",
    );
    const issued = await issueGrant(tx, [], {
      subject: { kind: 'person', id: personId },
      scope: WHOLE,
      collection: 'gate',
      action: 'decide',
      parentGrantId: null,
      grantedByActorId: actorId,
      expiresAt: soon?.at ?? null,
    });
    if (!issued.ok) throw new Error(`gate grant refused ${issued.refusal.code}`);
    return issued.value;
  });
}

describe.skipIf(serverUrl === undefined)('C80 request, authority after the task wait', () => {
  it('refuses a request whose run grant was revoked while it waited on the task', async () => {
    const fern = await enrol(w.world.db.app, w.world.business, 'fern');
    const runWrite = await w.world.db.app.withBusiness(w.world.business, async (tx) => {
      await grantTo(tx, fern, 'read');
      return await grantTo(tx, fern, 'write', WHOLE, false, 'run');
    });
    const raced = await whileParked(
      { table: 'records', id: w.taskA, statement: /^insert into public\.live_corrections/u },
      async () => await w.as(fern, requestBody(w.partyA, w.taskA)),
      async () => await revokeElsewhere(runWrite),
    );
    expect({
      parkedOn: raced.parkedOn,
      revoked: raced.meanwhile,
      code: codeOf(raced.result),
      stored: await correctionsBy(fern.personId),
    }).toStrictEqual({ parkedOn: true, revoked: true, code: 'SCOPE_NOT_GRANTED', stored: 0 });
  });
});

describe.skipIf(serverUrl === undefined)('C80 approver setting, authority after its wait', () => {
  it('refuses an approver setting whose settings grant was revoked while it waited on the setting', async () => {
    // One settings:manage grant, as the world's administrator holds, on a
    // member of its own so the world's administrator keeps theirs.
    const keeper = await enrol(w.world.db.app, w.world.business, 'keeper');
    const manage = await w.world.db.app.withBusiness(
      w.world.business,
      async (tx) => await grantTo(tx, keeper, 'manage', WHOLE, false, 'settings'),
    );
    const before = await approverSetting();
    if (before === undefined) throw new Error('the approver setting is not installed');
    const raced = await whileParked(
      { table: 'business_settings', id: before.id, statement: /business_settings/u },
      async () =>
        await w.as(keeper, {
          command: 'settings.set_live_correction_approver',
          value: w.cal.personId,
        }),
      async () => await revokeElsewhere(manage),
    );
    expect({
      parkedOn: raced.parkedOn,
      revoked: raced.meanwhile,
      code: codeOf(raced.result),
      setting: await approverSetting(),
    }).toStrictEqual({ parkedOn: true, revoked: true, code: 'SCOPE_NOT_GRANTED', setting: before });
  });
});

describe.skipIf(serverUrl === undefined)('C80 decision, authority after the approver wait', () => {
  it('refuses a decision whose gate grant expired while it waited on the approver setting', async () => {
    const gil = await w.world.decider('gil');
    expect(codeOf(await w.setApprover(gil.personId))).toBe('not-a-refusal');
    const asked = detailOf(await w.request(w.ava));
    const correctionId = String(asked['correctionId']);
    const setting = await approverSetting();
    if (setting === undefined) throw new Error('the approver setting is not installed');
    const gate = await soonEndingGateGrant(gil.personId, gil.actorId);
    const expiry = 'select expires_at from public.grants where id = $1';
    const raced = await whileParked(
      { table: 'business_settings', id: setting.id, statement: /business_settings/u },
      async () => await w.approve(gil, correctionId, String(asked['versionId'])),
      async () => {
        const [live] = await w.world.db.admin.execute<{ readonly live: boolean }>(
          `select (${expiry}) > clock_timestamp() as live`,
          [gate],
        );
        await waitPast(s, expiry, gate);
        return live?.live;
      },
    );
    expect({
      parkedOn: raced.parkedOn,
      liveWhenParked: raced.meanwhile,
      code: codeOf(raced.result),
      state: await w.stateOf(correctionId),
      setting: await approverSetting(),
    }).toStrictEqual({
      parkedOn: true,
      liveWhenParked: true,
      code: 'NOT_FOUND',
      state: 'requested',
      setting,
    });
  });
});
