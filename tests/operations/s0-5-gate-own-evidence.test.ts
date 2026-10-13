// SPDX-License-Identifier: AGPL-3.0-only
/* eslint-disable max-lines -- the two self-evidenced gate items share one world and its lock helpers */
//
// S0-5: the two gate items the installation can evidence itself, through the
// real API on a throwaway database. `tested-backups` is recorded only while a
// passed restore drill is stamped inside the restore window
// (`ops.last_tested_restore`, 0070) and its link is the operations page, where
// that date is shown; `second-factor` only while the person recording it has a
// verified factor of their own, on their row here or on their own login
// through any business (0064). Both are read after the installation's row
// lock, in the command's own transaction, so a stamp that is not committed when
// the lock is taken does not count, and one committed while the command waits
// on the lock does. Ada is alpha's owner, and alpha operates the installation.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  recordFactorEnrolled,
  recordFactorRemoved,
  recordFactorVerified,
} from '../../packages/core-records/src/index.ts';
import {
  bearer,
  call,
  createWorld,
  personPath,
  serverUrl,
  type Answer,
  type Caller,
  type World,
} from '../acceptance/world.ts';
import { insertLogin, insertMapping } from '../identity/fixture.ts';
import { hold, waitingOn } from '../support/lock-waits.ts';
import { RESTORE_DAYS } from './c55-last-tested-restore-world.ts';

if (serverUrl === undefined) {
  console.warn('operations/s0-5-gate-own-evidence: DATABASE_URL is unset, so nothing below ran.');
}

/** The operations page, where the last tested restore's date is shown (C55). */
const OPERATIONS_PAGE = 'https://ops.example/settings/operations/';
const USER_NAME = 'ada';

let world: World;

const admin = async <T>(sql: string, params: unknown[] = []): Promise<T[]> =>
  (await world.db.admin.execute<T & Record<string, unknown>>(sql, params)) as T[];

/** The gate's rows as plain objects, in item order. */
const gateRows = async (): Promise<{ item: string; evidence: string }[]> =>
  (
    await admin<{ item: string; evidence: string }>(
      'select item, evidence from ops.gate_items order by item',
    )
  ).map(({ item, evidence }) => ({ item, evidence }));

const send = async (item: string, evidence: string, who: Caller = world.ada): Promise<Answer> =>
  await call(
    world.api,
    personPath('alpha', '/operations/record_gate_item'),
    { operationId: randomUUID(), item, evidence },
    bearer(who.token),
  );

/** The restore stamp `days` and an hour old, or none at all. */
async function stampAged(days: number | null): Promise<void> {
  await admin('delete from ops.last_tested_restore');
  if (days === null) return;
  await admin(
    `insert into ops.last_tested_restore (one, at)
     values (true, date_trunc('milliseconds', now() - make_interval(days => $1) - interval '1 hour'))`,
    [days],
  );
}

/** The item open again, as before any case recorded it. */
const reopen = async (item: string): Promise<void> => {
  await admin('delete from ops.gate_items where item = $1', [item]);
};

/**
 * Each attempt, made with `item` open, refused FIELD_VALUE_INVALID naming
 * `field`, with nothing written to the gate.
 */
async function refusedNaming(
  item: string,
  attempts: readonly (readonly [label: string, send: () => Promise<Answer>])[],
  field: string,
): Promise<string[]> {
  const wrong: string[] = [];
  for (const [label, attempt] of attempts) {
    // oxlint-disable-next-line no-await-in-loop
    await reopen(item);
    // oxlint-disable-next-line no-await-in-loop
    const before = JSON.stringify(await gateRows());
    // oxlint-disable-next-line no-await-in-loop
    const answer = await attempt();
    const named = JSON.stringify(answer.body['names']);
    if (
      answer.status !== 422 ||
      answer.code !== 'FIELD_VALUE_INVALID' ||
      named !== `["${field}"]`
    ) {
      wrong.push(`${label}: ${String(answer.status)} ${answer.code} ${named}`);
    }
    // oxlint-disable-next-line no-await-in-loop
    if (JSON.stringify(await gateRows()) !== before) wrong.push(`${label}: wrote`);
  }
  return wrong;
}

const backups = (label: string, link = OPERATIONS_PAGE) =>
  [label, async () => await send('tested-backups', link)] as const;

/** The fixes a refusal carries, as one text. */
const fixesOf = (answer: Answer): string =>
  ((answer.body['fixes'] ?? []) as readonly string[]).join(' ');

/** A verified factor of `who`'s own, written as their enrolment and code step write it. */
async function verifiedFactor(who: Caller): Promise<void> {
  await world.db.app.withBusiness(world.alpha, async (tx) => {
    const factor = await recordFactorEnrolled(tx, {
      personId: who.personId as string,
      provider: 'supabase',
      providerFactorId: randomUUID(),
    });
    await recordFactorVerified(tx, {
      personId: who.personId as string,
      factorId: factor.id,
      subject: who.subject,
    });
  });
}

async function noDrill(): Promise<void> {
  await stampAged(null);
  expect(
    await refusedNaming('tested-backups', [backups('no drill stamped')], 'evidence'),
  ).toStrictEqual([]);
  expect(fixesOf(await send('tested-backups', OPERATIONS_PAGE))).toMatch(/restore drill/iu);
}

async function staleDrill(): Promise<void> {
  expect(RESTORE_DAYS).toBeGreaterThan(1);
  await stampAged(RESTORE_DAYS + 30);
  expect(
    await refusedNaming('tested-backups', [backups('a stale drill')], 'evidence'),
  ).toStrictEqual([]);
}

async function wrongLink(): Promise<void> {
  await stampAged(0);
  const links = [
    'https://ops.example/settings/operations',
    'https://ops.example/settings/',
    'https://ops.example/settings/operations/runbook',
    'https://ops.example/tested-backups',
    `https://${USER_NAME}@ops.example/settings/operations/`,
    `https://${USER_NAME}:${USER_NAME}@ops.example/settings/operations/`,
    'https://ops.example:8443/settings/operations/',
    'https://ops.example/settings/operations/?runbook=1.0',
    'https://ops.example/settings/operations/?',
    'https://ops.example/settings/operations/#restore',
    'https://ops.example/settings/operations/#',
  ];
  expect(
    await refusedNaming(
      'tested-backups',
      links.map((link) => backups(link, link)),
      'evidence',
    ),
  ).toStrictEqual([]);
}

async function recorded(): Promise<void> {
  await reopen('tested-backups');
  await stampAged(RESTORE_DAYS);
  expect(
    await refusedNaming('tested-backups', [backups('just past the window')], 'evidence'),
  ).toStrictEqual([]);
  await stampAged(RESTORE_DAYS - 1);
  const answer = await send('tested-backups', OPERATIONS_PAGE);
  expect({ status: answer.status, code: answer.code }).toStrictEqual({ status: 200, code: 'ok' });
  expect(await gateRows()).toStrictEqual([{ item: 'tested-backups', evidence: OPERATIONS_PAGE }]);
  await reopen('tested-backups');
}

/**
 * Ada's own login, reaching bravo as Bea, with a factor verified there: her
 * row in alpha still says no factor, as the login's factors are kept apart
 * from any one business's people (0064).
 */
async function verifiedThroughBravo(): Promise<() => Promise<void>> {
  return await world.db.app.withBusiness(world.bravo, async (tx) => {
    const login = await insertLogin(tx, world.ada.subject);
    const personId = world.bea.personId as string;
    await insertMapping(tx, login, personId, world.bea.actorId as string);
    const enrolled = await recordFactorEnrolled(tx, {
      personId,
      provider: 'supabase',
      providerFactorId: randomUUID(),
    });
    const factor = { personId, factorId: enrolled.id, subject: world.ada.subject };
    await recordFactorVerified(tx, factor);
    return async () => {
      await world.db.app.withBusiness(world.bravo, async (removing) => {
        await recordFactorRemoved(removing, factor);
      });
    };
  });
}

async function secondFactorElsewhere(): Promise<void> {
  const link = 'https://ops.example/settings';
  const remove = await verifiedThroughBravo();
  const [ada] = await admin<{ verified: boolean }>(
    'select second_factor_verified as verified from public.people where business_id = $1 and id = $2',
    [world.alpha, world.ada.personId],
  );
  expect(ada?.verified).toBe(false);
  await reopen('second-factor');
  const answer = await send('second-factor', link);
  expect({ status: answer.status, code: answer.code }).toStrictEqual({ status: 200, code: 'ok' });
  expect(await gateRows()).toStrictEqual([{ item: 'second-factor', evidence: link }]);
  await remove();
  const tries = [['ada, factor removed', async () => await send('second-factor', link)]] as const;
  expect(await refusedNaming('second-factor', tries, 'item')).toStrictEqual([]);
  await reopen('second-factor');
}

async function secondFactor(): Promise<void> {
  const link = 'https://ops.example/settings';
  const tries = [['ada, no factor', async () => await send('second-factor', link)]] as const;
  expect(await refusedNaming('second-factor', tries, 'item')).toStrictEqual([]);
  expect(fixesOf(await send('second-factor', link))).toMatch(/authenticator/iu);
  await verifiedFactor(world.mia);
  expect(await refusedNaming('second-factor', tries, 'item')).toStrictEqual([]);
  await verifiedFactor(world.ada);
  const answer = await send('second-factor', link);
  expect({ status: answer.status, code: answer.code }).toStrictEqual({ status: 200, code: 'ok' });
  expect(await gateRows()).toStrictEqual([{ item: 'second-factor', evidence: link }]);
}

async function race(): Promise<void> {
  await stampAged(null);
  await reopen('tested-backups');
  // A drill's stamp written and not yet committed: the command reads what was committed.
  let uncommitted: Answer | undefined;
  await world.db.admin.transaction(async (execute) => {
    await execute('select ops.record_tested_restore()');
    uncommitted = await send('tested-backups', OPERATIONS_PAGE);
  });
  expect(uncommitted?.code).toBe('FIELD_VALUE_INVALID');
  expect(uncommitted?.body['names']).toStrictEqual(['evidence']);
  expect(await gateRows()).toStrictEqual([{ item: 'second-factor', evidence: expect.any(String) }]);

  // A stale stamp, refreshed while the command waits on the installation's row lock.
  await stampAged(RESTORE_DAYS);
  const lock = await hold(world.db.appUrl, world.alpha, async (tx) => {
    await tx.query('select mode from ops.installation for update');
  });
  const waiting = send('tested-backups', OPERATIONS_PAGE);
  try {
    await waitingOn(world.db.admin, 'transactionid', 'from ops.installation for update');
    await admin('select ops.record_tested_restore()');
  } finally {
    await lock.letGo();
  }
  const answer = await waiting;
  expect({ status: answer.status, code: answer.code }).toStrictEqual({ status: 200, code: 'ok' });
  expect((await gateRows()).map((row) => row.item)).toStrictEqual([
    'second-factor',
    'tested-backups',
  ]);
}

/** A stamp fresh when the command began and stale after its lock wait does not count. */
async function staleAfterTheWait(): Promise<void> {
  await reopen('tested-backups');
  await admin('delete from ops.last_tested_restore');
  await admin(
    `insert into ops.last_tested_restore (one, at)
     values (true, date_trunc('milliseconds', clock_timestamp() - make_interval(days => $1) + interval '2 seconds'))`,
    [RESTORE_DAYS],
  );
  const lock = await hold(world.db.appUrl, world.alpha, async (tx) => {
    await tx.query('select mode from ops.installation for update');
  });
  const waiting = send('tested-backups', OPERATIONS_PAGE);
  try {
    await waitingOn(world.db.admin, 'transactionid', 'from ops.installation for update');
    await new Promise((resolve) => {
      setTimeout(resolve, 3_000);
    });
  } finally {
    await lock.letGo();
  }
  const answer = await waiting;
  expect([answer.code, answer.body['names']]).toStrictEqual(['FIELD_VALUE_INVALID', ['evidence']]);
  expect((await gateRows()).map((row) => row.item)).not.toContain('tested-backups');
}

describe.skipIf(serverUrl === undefined)('S0-5 gate items on their own evidence', () => {
  beforeAll(async () => {
    world = await createWorld('s05_gate_own_evidence');
  }, 180_000);

  afterAll(async () => {
    await world?.close();
  });

  it(
    'S0-5 tested backups, no drill: with no restore stamped, tested-backups is refused naming evidence and writes nothing',
    noDrill,
  );

  it(
    'S0-5 tested backups, stale drill: a restore stamped longer ago than the restore window is refused naming evidence and writes nothing',
    staleDrill,
  );

  it(
    'S0-5 tested backups, wrong link: with a fresh restore stamped, any link but the operations page, or that page behind a user name, password, port, query or fragment, is refused naming evidence',
    wrongLink,
  );

  it(
    'S0-5 tested backups, recorded: the operations page link records the item on a restore stamped a day inside the window, and not on one just past it',
    recorded,
  );

  it(
    "S0-5 second factor, own login elsewhere: recorded while the recording person's own login has a factor verified through another business, though their row here has none; refused once that factor is removed",
    secondFactorElsewhere,
  );

  it(
    "S0-5 second factor: refused naming item while the recording person has no verified factor, another person's included; recorded once they have one",
    secondFactor,
  );

  it(
    'S0-5 tested backups, race: a stamp not yet committed when the command reads it does not count; one committed while the command waits on the installation lock does',
    race,
  );

  it(
    'S0-5 tested backups, time after the lock: a stamp that leaves the window while the command waits on the installation lock is refused',
    staleAfterTheWait,
    30_000,
  );
});
