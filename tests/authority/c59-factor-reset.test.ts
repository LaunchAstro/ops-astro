// SPDX-License-Identifier: AGPL-3.0-only
//
// C59 (ORCH65-Q3): the owner resets a member's lost authenticator.
//
// `access.reset_factor {holderId}` is the tracked action `second factor reset
// (person, by)` under `settings:manage`, never an agent's, asking the owner's
// own fresh step-up whatever the money setting. In one transaction under the
// access lock the member's live factor is recorded removed, their sessions
// are ended, and one provider step is written owing the admin removal of that
// factor. The caller's own person is refused; a holder with no live membership
// here is NOT_FOUND; a login live in another business is refused in words
// that say nothing of where, audited, with nothing written or sent.
//
// Ada owns alpha and holds every key; Mia holds the task keys; Noah holds
// nothing; Bea is bravo's. Each case enrols the member it resets.

import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { DELEGATION_HEADER } from '../../packages/core-wire/src/surface.ts';
import { agentPath, bearer, call, serverUrl } from '../acceptance/world.ts';
import { enrol, grantTo, shareWithClient, WHOLE_BUSINESS } from '../commands/fixture.ts';
import {
  apiWith,
  clientToken,
  credential,
  harness,
  nowSeconds,
  outcome,
  teammate,
  useEndAccessWorld,
} from './c58-end-access-world.ts';
import {
  factorFake,
  liveInBravo,
  memberWithFactor,
  moneyStepUp,
  reset,
  resetState,
  served,
  sessionToken,
  withFactor,
} from './c59-factor-reset-world.ts';

useEndAccessWorld();

const OK = { status: 200, code: 'ok' };
const REFUSED = { status: 409, code: 'FACTOR_RESET_REFUSED' };

/** The newest audit row of the reset, as the envelope wrote it. */
const lastAudit = async () =>
  (
    await harness.world.db.app.withBusiness(
      harness.world.alpha,
      async (tx) =>
        await tx.query<{
          readonly actor: string;
          readonly subject: string | null;
          readonly outcome: string;
          readonly code: string | null;
          readonly at: Date;
          readonly row: string;
        }>(
          `select actor_id::text as actor, subject_record_id::text as subject, outcome,
                  refusal_code as code, occurred_at as at, to_jsonb(e)::text as row
             from public.audit_events e
            where command = 'access.reset_factor'
            order by seq desc limit 1`,
        ),
    )
  )[0];

async function ownerResetsAMember(): Promise<void> {
  const api = apiWith();
  const member = await memberWithFactor('ivy');
  const before = await resetState(member.person);
  expect(before).toMatchObject({ factors: ['verified'], mirror: true, resets: [] });
  const startedAt = Date.now();

  const answer = await reset(api, member.person.personId);
  expect(outcome(answer)).toEqual(OK);
  const detail = answer.body['detail'] as Record<string, unknown>;
  expect(detail).toEqual({ resetId: expect.any(String), providerStep: 'owed' });

  const after = await resetState(member.person);
  expect(after.factors).toEqual(['removed']);
  expect(after.mirror).toBe(false);
  expect(after.endedHere).toContain(member.sessionId);
  expect(after.resets).toEqual([
    {
      done: false,
      attempts: 0,
      fault: null,
      by: harness.world.ada.actorId,
      factor: member.factorId,
    },
  ]);
  // The old session is refused from the commit; a new sign-in needs no factor.
  expect(await served(member.token)).toEqual({ status: 401, code: 'AUTH_SESSION_EXPIRED' });
  const fresh = await sessionToken(member.person.presented.subject, {
    signedInAt: nowSeconds() + 1,
    factorAt: null,
  });
  expect(await served(fresh)).toEqual(OK);

  const audit = await lastAudit();
  expect(audit).toMatchObject({
    actor: harness.world.ada.actorId,
    subject: member.person.personId,
    outcome: 'applied',
  });
  expect(audit?.at.getTime()).toBeGreaterThanOrEqual(startedAt - 5000);
  expect(audit?.row).not.toContain(member.person.presented.subject);
  expect(audit?.row).not.toContain(member.factorId);
}

async function staleStepUpRefused(): Promise<void> {
  const api = apiWith(factorFake().provider);
  const member = await memberWithFactor('jay');
  const before = await resetState(member.person);
  const subject = harness.world.ada.presented.subject;
  const stale = await sessionToken(subject, {
    signedInAt: nowSeconds() - 3700,
    factorAt: nowSeconds() - 3700,
  });
  const noFactor = await sessionToken(subject, { factorAt: null });
  const refusedBoth = async () => {
    for (const token of [stale, noFactor]) {
      // oxlint-disable-next-line no-await-in-loop
      expect(outcome(await reset(api, member.person.personId, token))).toEqual({
        status: 403,
        code: 'STEP_UP_REQUIRED',
      });
    }
  };
  await refusedBoth();
  // Whatever the money setting: off, the owner's own step-up is still asked.
  await moneyStepUp(false);
  try {
    await refusedBoth();
  } finally {
    await moneyStepUp(true);
  }
  expect(await resetState(member.person)).toEqual(before);
}

async function ownPersonRefused(): Promise<void> {
  const { calls, provider } = factorFake();
  const ada = harness.world.ada;
  const answer = await reset(apiWith(provider), ada.personId);
  expect(outcome(answer)).toEqual(REFUSED);
  expect(calls).toEqual([]);
}

async function agentRefused(): Promise<void> {
  const member = await memberWithFactor('kit');
  const before = await resetState(member.person);
  const answer = await call(
    apiWith(factorFake().provider),
    agentPath('alpha', '/access/reset_factor'),
    { operationId: randomUUID(), holderId: member.person.personId },
    bearer(harness.world.agent.token),
  );
  expect(outcome(answer)).toEqual({ status: 403, code: 'DELEGATION_EXCLUDES_OPERATION' });
  expect(await resetState(member.person)).toEqual(before);
}

async function withoutSettingsManageRefused(): Promise<void> {
  const api = apiWith(factorFake().provider);
  const member = await memberWithFactor('lux');
  const before = await resetState(member.person);
  // A manager of access, but not of settings, is refused like the others.
  const keeper = await enrol(harness.world.db.app, harness.world.alpha, `keeper-${randomUUID()}`);
  await harness.world.db.app.withBusiness(harness.world.alpha, async (tx) => {
    await grantTo(tx, keeper, 'manage', WHOLE_BUSINESS, false, 'access');
  });
  const keeperToken = await sessionToken(keeper.presented.subject);
  const tokens = [harness.world.mia.token, harness.world.noah.token, keeperToken, clientToken];
  for (const token of tokens) {
    // oxlint-disable-next-line no-await-in-loop
    const refused = await reset(api, member.person.personId, token);
    expect(refused.status).toBe(403);
    expect(['SCOPE_NOT_GRANTED', 'AUTH_NO_MEMBERSHIP']).toContain(refused.code);
  }
  expect(await resetState(member.person)).toEqual(before);
}

async function threeCrossings(): Promise<void> {
  const { calls, provider } = factorFake();
  const api = apiWith(provider);
  // Another business: bravo's member is answered as a made-up id is.
  const bravoMate = await memberWithFactor('max', harness.world.bravo);
  const bravoBefore = await resetState(bravoMate.person, harness.world.bravo);
  const across = await reset(api, bravoMate.person.personId);
  const madeUp = await reset(api, randomUUID());
  expect(outcome(across)).toEqual({ status: 404, code: 'NOT_FOUND' });
  expect(across.body).toEqual(madeUp.body);
  expect(JSON.stringify(across.body)).not.toContain(bravoMate.person.personId);
  expect(await resetState(bravoMate.person, harness.world.bravo)).toEqual(bravoBefore);

  // A client person of this business holds no membership here.
  const ada = harness.world.ada as unknown as Parameters<typeof shareWithClient>[2];
  const client = await shareWithClient(
    harness.world.db.app,
    harness.world.alpha,
    ada,
    harness.alphaTask.id,
  );
  await withFactor(client);
  const clientBefore = await resetState(client);
  expect(outcome(await reset(api, client.personId))).toEqual({ status: 404, code: 'NOT_FOUND' });
  expect(await resetState(client)).toEqual(clientBefore);

  // Another person acting on Ada's behalf: her delegated agent is refused.
  const member = await memberWithFactor('ned');
  const memberBefore = await resetState(member.person);
  const delegated = await call(
    api,
    agentPath('alpha', '/access/reset_factor'),
    { operationId: randomUUID(), holderId: member.person.personId },
    { ...bearer(harness.world.agent.token), [DELEGATION_HEADER]: credential },
  );
  expect(outcome(delegated)).toEqual({ status: 403, code: 'DELEGATION_EXCLUDES_OPERATION' });
  expect(await resetState(member.person)).toEqual(memberBefore);
  expect(calls).toEqual([]);
}

async function liveElsewhereRefused(): Promise<void> {
  const { calls, provider } = factorFake();
  const api = apiWith(provider);
  const member = await memberWithFactor('ora');
  await liveInBravo(member.person.presented.subject);
  const before = await resetState(member.person);

  const refused = await reset(api, member.person.personId);
  expect(outcome(refused)).toEqual(REFUSED);
  // The words are the ones every refusal of this code carries, and name no place.
  const own = await reset(api, harness.world.ada.personId);
  expect(refused.body['fixes']).toEqual(own.body['fixes']);
  expect(refused.body['fields']).toEqual(own.body['fields']);
  const words = JSON.stringify(refused.body).toLowerCase();
  for (const leak of ['bravo', 'elsewhere', 'another business', 'other business', 'shared']) {
    expect(words).not.toContain(leak);
  }
  expect(await lastAudit()).toMatchObject({ outcome: 'refused', code: 'FACTOR_RESET_REFUSED' });
  expect(await resetState(member.person)).toEqual(before);
  expect(await served(member.token)).toEqual(OK);
  expect(calls).toEqual([]);
}

async function notEnrolledRefused(): Promise<void> {
  const api = apiWith(factorFake().provider);
  const member = await memberWithFactor('pip');
  const { person: bare } = await teammate('quin');
  const { person: half } = await teammate('rue');
  await withFactor(half, harness.world.alpha, false);
  for (const holder of [bare, half]) {
    // oxlint-disable-next-line no-await-in-loop
    expect(outcome(await reset(api, holder.personId))).toEqual({
      status: 409,
      code: 'FACTOR_NOT_ENROLLED',
    });
  }
  // Reset once, a second reset finds no factor to clear.
  expect(outcome(await reset(api, member.person.personId))).toEqual(OK);
  expect(outcome(await reset(api, member.person.personId))).toEqual({
    status: 409,
    code: 'FACTOR_NOT_ENROLLED',
  });
}

describe.skipIf(serverUrl === undefined)("C59 the owner resets a member's factor", () => {
  it(
    'C59 reset: the owner resets a member: factor recorded removed, sessions here ended, audit row names who, whom and when, owed step written',
    ownerResetsAMember,
  );
  it(
    'C59 reset: a stale owner step-up is refused STEP_UP_REQUIRED whatever the money setting, and nothing is written',
    staleStepUpRefused,
  );
  it("C59 reset: the caller's own person is refused FACTOR_RESET_REFUSED", ownPersonRefused);
  it('C59 reset: an agent caller is refused, with nothing written', agentRefused);
  it(
    'C59 reset: a caller without settings:manage is refused, with nothing written',
    withoutSettingsManageRefused,
  );
  it(
    'C59 reset: three crossings: another business is NOT_FOUND naming nothing of it, a client person of this business is NOT_FOUND, another acting on behalf is refused',
    threeCrossings,
  );
  it(
    'C59 reset: a login live in another business is refused FACTOR_RESET_REFUSED in words that leak nothing, audited refused, nothing written or sent',
    liveElsewhereRefused,
  );
  it(
    'C59 reset: a member with no verified live factor here is FACTOR_NOT_ENROLLED',
    notEnrolledRefused,
  );
});
