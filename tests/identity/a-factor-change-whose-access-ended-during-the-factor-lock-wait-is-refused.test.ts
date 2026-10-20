// SPDX-License-Identifier: AGPL-3.0-only
//
// Each second-factor act records its change in a second transaction that
// resolves the caller, then waits for the login's factor lock (`liveFactor`
// with `lock`), and judges the caller's standing again after its last wait
// (`judged`). Ending a person's access (`access.end`) ends their membership and
// acting identity here and writes no session ending, so asking only whether the
// session ended misses it. One login stands in two businesses, its factor held
// through the first. A fixture holds the factor lock; the act's record step is
// admitted and parks on it; a manager ends the person's access here and it
// commits; then the fixture lets go. The act must be refused `AUTH_ACCESS_ENDED`:
// no factor enrolled, verified or removed, no applied event, and nothing removed
// at the provider, a losing enrolment included. Endings elsewhere (the same login in the other business,
// another person here) are not this caller's standing here, and change nothing.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it as vitestIt } from 'vitest';
import { executeCommand } from '../../packages/core-commands/src/commands/envelope.ts';
import type { FactorCaller } from '../../packages/core-commands/src/commands/account-factor.ts';
import type { FactorProvider } from '../../packages/core-commands/src/commands/account-factor-provider.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import {
  liveFactor,
  loginHasVerifiedFactor,
  recordFactorEnrolled,
  recordFactorVerified,
} from '../../packages/core-records/src/identity/second-factor.ts';
import {
  advisoryLock,
  connect,
  type BusinessId,
  type TenantQuery,
} from '../../packages/core-records/src/tenancy/database.ts';
import { enrol, grantTo, installSpine, WHOLE_BUSINESS, type Member } from '../commands/fixture.ts';
import {
  createFreshDatabase,
  databaseUrlFromEnvironment,
  type FreshDatabase,
} from '../support/fresh-database.ts';
import { hold, waitingOn, type Held } from '../support/lock-waits.ts';
import { insertBusiness } from './fixture.ts';
import {
  ACTS,
  factorCaller,
  factorLockKey,
  provider,
  standingElsewhere,
} from './factor-lock-wait-fixture.ts';

const it = databaseUrlFromEnvironment() === undefined ? vitestIt.skip : vitestIt;

let db: FreshDatabase;
let business: BusinessId;
let ada: Member;
beforeAll(async () => {
  if (databaseUrlFromEnvironment() === undefined) return;
  db = await createFreshDatabase({ part: 'factoraccessend' });
  business = (await insertBusiness(db.app, 'factor-access-end')) as BusinessId;
  ada = await manager(business, 'Ada Lane');
}, 180_000);
afterAll(async () => {
  await db?.drop();
});

/** A member of `businessId`, which serves commands, who may end others' access there. */
async function manager(businessId: string, name: string): Promise<Member> {
  await installSpine(db.app, businessId);
  const member = await enrol(db.app, businessId, name);
  await db.app.withBusiness(businessId, async (tx) => {
    await grantTo(tx, member, 'manage', WHOLE_BUSINESS, false, 'access');
  });
  return member;
}

/** `by` ends `holder`'s access in `businessId`, committed on a connection of its own. */
async function endAccess(by: Member, businessId: string, holder: string): Promise<string> {
  const other = connect(db.appUrl);
  try {
    const body = { command: 'access.end', operationId: randomUUID(), holderId: holder };
    const answer = await executeCommand(other, businessId, by.presented, 'api', body as never);
    return isCommandRefusal(answer) ? answer.code : 'applied';
  } finally {
    await other.close();
  }
}

/** `act` by `asked`, with `meanwhile` run once its record step waits on the factor lock. */
async function duringFactorLockWait(
  act: keyof typeof ACTS,
  asked: FactorCaller,
  to: FactorProvider,
  meanwhile: () => Promise<void>,
): Promise<unknown> {
  const actor = connect(db.appUrl);
  try {
    const factorLock = await hold(db.appUrl, business, async (tx) => {
      await advisoryLock(tx, factorLockKey(asked.presented.subject));
    });
    let acting: Promise<unknown> | undefined;
    try {
      acting = ACTS[act]({ ...asked, database: actor }, to);
      await waitingOn(db.admin, 'advisory', 'pg_advisory_xact_lock');
      await meanwhile();
    } finally {
      await factorLock.letGo();
    }
    return await acting;
  } finally {
    await actor.close();
  }
}

/** What the act left: the person's live factor, the login's factor anywhere, its applied events. */
async function left(person: string, subject: string, command: string): Promise<unknown> {
  const factor = await db.app.withBusiness(business, async (tx) => ({
    status: (await liveFactor(tx, person, subject))?.status ?? 'none',
    heldByLogin: await loginHasVerifiedFactor(tx, subject),
  }));
  const [events] = await db.admin.execute<{ readonly applied: number }>(
    `select count(*)::int as applied from public.audit_events
      where business_id = $1 and command = $2 and outcome = 'applied'`,
    [business, command],
  );
  return { ...factor, applied: events?.applied };
}

it.each(['enrol', 'verify', 'remove'] as const)(
  'a factor %s whose access ended during the factor lock wait is refused as ended, and changes nothing',
  async (act) => {
    const { caller: asked, person } = await factorCaller(db, business, act !== 'enrol');
    await standingElsewhere(db, asked.presented.subject);
    const removed: string[] = [];
    const result = await duringFactorLockWait(act, asked, provider(removed), async () => {
      expect(await endAccess(ada, business, person)).toBe('applied');
    });
    expect({
      result,
      removed,
      left: await left(person, asked.presented.subject, `account.factor_${act}`),
    }).toMatchObject({
      result: { refused: true, code: 'AUTH_ACCESS_ENDED' },
      // A refused enrolment's issued factor goes at the provider; nothing else does.
      removed: act === 'enrol' ? [expect.stringMatching(/^factor-/u)] : [],
      left: {
        status: act === 'enrol' ? 'none' : 'verified',
        heldByLogin: act !== 'enrol',
        applied: 0,
      },
    });
  },
);

it('a factor removal is kept when, during its factor lock wait, the same login loses access elsewhere and another person loses it here', async () => {
  const { caller: asked, person } = await factorCaller(db, business, true);
  const elsewhere = await standingElsewhere(db, asked.presented.subject);
  const owner = await manager(elsewhere.business, 'Ola Berg');
  const bystander = await enrol(db.app, business, 'Bo Hart');
  const removed: string[] = [];
  const before = await left(person, asked.presented.subject, 'account.factor_remove');
  const result = await duringFactorLockWait('remove', asked, provider(removed), async () => {
    expect(await endAccess(owner, elsewhere.business, elsewhere.person)).toBe('applied');
    expect(await endAccess(ada, business, bystander.personId)).toBe('applied');
  });
  expect({ before, result, removed: removed.length }).toMatchObject({
    before: { status: 'verified', heldByLogin: true },
    result: { removed: true },
    removed: 1,
  });
  expect(await left(person, asked.presented.subject, 'account.factor_remove')).toMatchObject({
    status: 'none',
    heldByLogin: false,
  });
});

/** An unverified enrolment of `person`, by the login `subject`, in the transaction's business. */
const enrolled = async (tx: TenantQuery, person: string, subject: string) =>
  await recordFactorEnrolled(tx, {
    personId: person,
    subject,
    provider: 'supabase',
    providerFactorId: `factor-${randomUUID()}`,
  });

it('a factor verify whose losing enrolment was undone by its access ending removes nothing at the provider', async () => {
  const { caller: asked, person } = await factorCaller(db, business, false);
  const { subject } = asked.presented;
  const elsewhere = await standingElsewhere(db, subject);
  await db.app.withBusiness(business, async (tx) => await enrolled(tx, person, subject));
  const removed: string[] = [];
  let factorLock: Held | undefined;
  const to: FactorProvider = {
    ...provider(removed),
    // Between the act's two transactions the login verifies a factor through
    // the other business, so the record step finds this enrolment lost; then
    // the factor lock is held, so that step parks on it.
    verify: async (token, factorId, code) => {
      await db.app.withBusiness(elsewhere.business, async (tx) => {
        const factor = await enrolled(tx, elsewhere.person, subject);
        const { person: holder } = elsewhere;
        await recordFactorVerified(tx, { personId: holder, factorId: factor.id, subject });
      });
      factorLock = await hold(db.appUrl, business, async (tx) => {
        await advisoryLock(tx, factorLockKey(subject));
      });
      return await provider(removed).verify(token, factorId, code);
    },
  };
  const actor = connect(db.appUrl);
  try {
    let verifying: Promise<unknown> | undefined;
    try {
      verifying = ACTS.verify({ ...asked, database: actor }, to);
      await waitingOn(db.admin, 'advisory', 'pg_advisory_xact_lock');
      expect(await endAccess(ada, business, person)).toBe('applied');
    } finally {
      await factorLock?.letGo();
    }
    expect({
      result: await verifying,
      removed,
      status: (await db.app.withBusiness(business, (tx) => liveFactor(tx, person, subject)))
        ?.status,
    }).toMatchObject({
      result: { refused: true, code: 'AUTH_ACCESS_ENDED' },
      removed: [],
      status: 'unverified',
    });
  } finally {
    await actor.close();
  }
});
