// SPDX-License-Identifier: AGPL-3.0-only
//
// A factor act sent after its caller's access ended here, and sent again by a
// client that retries. The ending has committed, so each is refused
// `AUTH_ACCESS_ENDED` at the door, before any call to the sign-in provider: no
// factor enrolled, verified or removed, and no applied event.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it as vitestIt } from 'vitest';
import { executeCommand } from '../../packages/core-commands/src/commands/envelope.ts';
import type { FactorProvider } from '../../packages/core-commands/src/commands/account-factor-provider.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import {
  liveFactor,
  recordFactorEnrolled,
} from '../../packages/core-records/src/identity/second-factor.ts';
import { type BusinessId } from '../../packages/core-records/src/tenancy/database.ts';
import { enrol, grantTo, installSpine, WHOLE_BUSINESS, type Member } from '../commands/fixture.ts';
import {
  createFreshDatabase,
  databaseUrlFromEnvironment,
  type FreshDatabase,
} from '../support/fresh-database.ts';
import { insertBusiness } from './fixture.ts';
import { ACTS, factorCaller, provider } from './factor-lock-wait-fixture.ts';

const it = databaseUrlFromEnvironment() === undefined ? vitestIt.skip : vitestIt;

let db: FreshDatabase;
let business: BusinessId;
let ada: Member;
beforeAll(async () => {
  if (databaseUrlFromEnvironment() === undefined) return;
  db = await createFreshDatabase({ part: 'factorretry' });
  business = (await insertBusiness(db.app, 'factor-retry')) as BusinessId;
  await installSpine(db.app, business);
  ada = await enrol(db.app, business, 'Ada Lane');
  await db.app.withBusiness(business, async (tx) => {
    await grantTo(tx, ada, 'manage', WHOLE_BUSINESS, false, 'access');
  });
}, 180_000);
afterAll(async () => {
  await db?.drop();
});

it.each(['enrol', 'verify', 'remove'] as const)(
  'a factor %s sent again after its access ended is refused at the door and changes nothing',
  async (act) => {
    const { caller: asked, person } = await factorCaller(db, business, act === 'remove');
    if (act === 'verify')
      await db.app.withBusiness(business, (tx) =>
        recordFactorEnrolled(tx, {
          personId: person,
          subject: asked.presented.subject,
          provider: 'supabase',
          providerFactorId: `factor-${randomUUID()}`,
        }),
      );
    const before = (
      await db.app.withBusiness(business, (tx) => liveFactor(tx, person, asked.presented.subject))
    )?.status;
    const body = { command: 'access.end', operationId: randomUUID(), holderId: person };
    const ended = await executeCommand(db.app, business, ada.presented, 'api', body as never);
    expect(isCommandRefusal(ended)).toBe(false);
    const calls: string[] = [];
    const answering = provider([]);
    const to = Object.fromEntries(
      Object.entries(answering).map(([name, call]) => [
        name,
        (...args: never[]) => {
          calls.push(name);
          return (call as (...a: never[]) => unknown)(...args);
        },
      ]),
    ) as unknown as FactorProvider;
    const sent = await ACTS[act](asked, to);
    const again = await ACTS[act](asked, to);
    const [events] = await db.admin.execute<{ readonly applied: number }>(
      `select count(*)::int as applied from public.audit_events e
         join public.actors a on a.business_id = e.business_id and a.id = e.actor_id
        where e.business_id = $1 and a.person_id = $2::uuid and e.command = $3
          and e.outcome = 'applied'`,
      [business, person, `account.factor_${act}`],
    );
    const live = await db.app.withBusiness(business, (tx) =>
      liveFactor(tx, person, asked.presented.subject),
    );
    expect({ sent, again, calls, applied: events?.applied, status: live?.status }).toMatchObject({
      sent: { refused: true, code: 'AUTH_ACCESS_ENDED' },
      again: { refused: true, code: 'AUTH_ACCESS_ENDED' },
      calls: [],
      applied: 0,
      status: before,
    });
  },
);
