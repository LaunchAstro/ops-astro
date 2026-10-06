// SPDX-License-Identifier: AGPL-3.0-only
//
// An access ending whose provider user is already gone (GoTrue's 404
// `user_not_found`) ends in a final done state: both steps stamped on that
// ending, in its own business, never asked again and never counted owed by
// the endings loop. A transient failure (5xx, 429) and a 404 that does not
// name the user gone stay owed and are retried on every pass. The provider is
// the real GoTrue adapter over a fake fetch answering per subject.

import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createGoTrueLogins } from '../../apps/api/auth/logins.ts';
import { retryOwedSteps } from '../../apps/endings/pass.ts';
import { serverUrl } from '../acceptance/world.ts';
import { freshSubject, type Member } from '../commands/fixture.ts';
import {
  insertActor,
  insertLogin,
  insertMapping,
  insertMembership,
  insertPerson,
} from '../identity/fixture.ts';
import {
  apiWith,
  end,
  harness,
  outcome,
  stateOf,
  useEndAccessWorld,
} from './c58-end-access-world.ts';

useEndAccessWorld();

const USER_GONE = { code: 404, error_code: 'user_not_found', msg: 'User not found' };

/** GoTrue over a fake fetch: each subject's answer by its own script, and every call counted. */
function goTrueAnswering(answers: Record<string, () => Response>) {
  const asked: Record<string, number> = {};
  const logins = createGoTrueLogins({
    baseUrl: 'http://127.0.0.1:9/auth/v1',
    adminKey: () => Promise.resolve('admin-key'),
    timeoutMs: 1000,
    fetch: (input) => {
      const subject = String(input).split('/admin/users/')[1] ?? '';
      asked[subject] = (asked[subject] ?? 0) + 1;
      const answer = answers[subject];
      return Promise.resolve(answer === undefined ? new Response(null, { status: 503 }) : answer());
    },
  });
  return { logins, asked };
}

/**
 * A member of `businessId` whose login carries a GoTrue-shaped subject (a
 * UUID), as a real one does: the shared fixture's `name-<uuid>` subject is
 * never sent to the provider at all.
 */
async function memberWithProviderSubject(
  businessId: string,
  name: string,
): Promise<{ readonly person: Member; readonly subject: string }> {
  const subject = randomUUID();
  const person = await harness.world.db.app.withBusiness(businessId, async (tx) => {
    const personId = await insertPerson(tx, name);
    const actorId = await insertActor(tx, personId);
    await insertMembership(tx, personId);
    await insertMapping(tx, await insertLogin(tx, subject), personId, actorId);
    return { personId, actorId, presented: freshSubject(subject) };
  });
  return { person, subject };
}

/** One loop pass, claims expiring at once: what `pnpm endings` prints as owed. */
const pass = async (logins: ReturnType<typeof goTrueAnswering>['logins']): Promise<number> =>
  await retryOwedSteps(harness.world.db.admin, harness.world.db.app, logins, 0);

/** Every step owed across businesses, as the loop counts them: endings and factor resets. */
const owedNow = async (): Promise<number> =>
  Number(
    (
      await harness.world.db.admin.execute<{ readonly n: string }>(
        `select (select count(*) from public.access_endings
                  where sessions_ended_at is null or login_deactivated_at is null)
              + (select count(*) from public.factor_resets where done_at is null) as n`,
      )
    )[0]?.n,
  );

async function settleGoneEndingForGood() {
  const { world } = harness;
  const gone = await memberWithProviderSubject(world.alpha, 'gone');
  const elsewhere = await memberWithProviderSubject(world.bravo, 'elsewhere');
  // The act with no provider: both steps owed on both endings.
  expect(outcome(await end(apiWith(), gone.person.personId))).toEqual({
    status: 200,
    code: 'ok',
  });
  expect(
    outcome(await end(apiWith(), elsewhere.person.personId, world.bea.token, 'bravo')),
  ).toEqual({ status: 200, code: 'ok' });
  const owedBefore = await owedNow();

  const goneSubject = gone.subject;
  const elsewhereSubject = elsewhere.subject;
  const { logins, asked } = goTrueAnswering({
    [goneSubject]: () => Response.json(USER_GONE, { status: 404 }),
    [elsewhereSubject]: () => new Response(null, { status: 503 }),
  });

  // The gone ending leaves the backlog; bravo's stays in it.
  expect(await pass(logins)).toBe(owedBefore - 1);
  expect((await stateOf(gone.person)).endings).toEqual([
    expect.objectContaining({ sessions: true, login: true, fault: null }),
  ]);
  expect((await stateOf(elsewhere.person, world.bravo)).endings).toEqual([
    expect.objectContaining({ sessions: false, login: false, fault: 'unreachable' }),
  ]);
  expect(asked[goneSubject]).toBe(2);
  expect(asked[elsewhereSubject]).toBe(1);

  // The next pass never asks about the gone user again; bravo's is asked again.
  expect(await pass(logins)).toBe(owedBefore - 1);
  expect(asked[goneSubject]).toBe(2);
  expect(asked[elsewhereSubject]).toBe(2);
  expect((await stateOf(gone.person)).endings).toEqual([
    expect.objectContaining({ sessions: true, login: true, attempts: 1 }),
  ]);
  expect((await stateOf(elsewhere.person, world.bravo)).endings).toEqual([
    expect.objectContaining({ sessions: false, login: false, attempts: 2 }),
  ]);
}

async function retryTransientAndDoubtful() {
  const answers: readonly (readonly [string, () => Response, string])[] = [
    ['busy', () => Response.json(USER_GONE, { status: 429 }), 'refused'],
    ['down', () => Response.json(USER_GONE, { status: 503 }), 'unreachable'],
    ['plain404', () => new Response('not found', { status: 404 }), 'refused'],
    [
      'other404',
      () => Response.json({ error_code: 'mfa_factor_not_found' }, { status: 404 }),
      'refused',
    ],
  ];
  const people: Member[] = [];
  const subjects: string[] = [];
  for (const [name] of answers) {
    // oxlint-disable-next-line no-await-in-loop
    const { person, subject } = await memberWithProviderSubject(harness.world.alpha, name);
    subjects.push(subject);
    // oxlint-disable-next-line no-await-in-loop
    expect(outcome(await end(apiWith(), person.personId)), name).toEqual({
      status: 200,
      code: 'ok',
    });
    people.push(person);
  }
  const script = Object.fromEntries(
    answers.map(([, answer], index) => [subjects[index] ?? '', answer]),
  );
  const { logins, asked } = goTrueAnswering(script);
  const owedBefore = await owedNow();

  expect(await pass(logins)).toBe(owedBefore);
  expect(await pass(logins)).toBe(owedBefore);
  for (const [index, [name, , fault]] of answers.entries()) {
    const person = people[index];
    if (person === undefined) throw new Error(name);
    expect(asked[subjects[index] ?? ''], name).toBe(2);
    // oxlint-disable-next-line no-await-in-loop
    expect((await stateOf(person)).endings, name).toEqual([
      expect.objectContaining({ sessions: false, login: false, attempts: 2, fault }),
    ]);
  }
}

describe.skipIf(serverUrl === undefined)('an access ending whose provider user is gone', () => {
  it(
    "is settled for good in its own business, while another business's ending stays owed",
    settleGoneEndingForGood,
  );

  it(
    'stays owed and retried on a transient failure or a 404 that does not name the user gone',
    retryTransientAndDoubtful,
  );
});
