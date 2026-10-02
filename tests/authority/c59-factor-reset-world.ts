// SPDX-License-Identifier: AGPL-3.0-only
//
// What the factor-reset suites share (C59, ORCH65-Q3): C58's world (Ada owns
// alpha and holds `settings:manage`; Bea is bravo's), a provider stand-in that
// records each admin removal, members with a verified factor and a seen
// session, and readers of what a reset wrote. Every name below is made up.

import { randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import type { LoginProvider, ProviderAnswer } from '../../packages/core-commands/src/index.ts';
import {
  recordFactorEnrolled,
  recordFactorVerified,
} from '../../packages/core-records/src/index.ts';
import { ACCEPTANCE_ISSUER } from '../acceptance/cast.ts';
import { bearer, call, personPath, type Answer } from '../acceptance/world.ts';
import { grantTo, WHOLE_BUSINESS, type Member } from '../commands/fixture.ts';
import {
  insertActor,
  insertLogin,
  insertMapping,
  insertMembership,
  insertPerson,
} from '../identity/fixture.ts';
import { signBearer } from '../support/sign-in.ts';
import { apiWith, harness, nowSeconds, teammate } from './c58-end-access-world.ts';

export const CANARY = 'CANARY-c59-factor-reset-7d20aa';

/** What `factorFake` hands back: the removals and other calls it saw, and the provider. */
export interface FactorFake {
  readonly calls: { readonly subject: string; readonly factorId: string }[];
  readonly others: string[];
  readonly provider: LoginProvider;
}

/** A provider that answers each removal from a script, and records every call. */
export function factorFake(
  script: (ProviderAnswer<void> | 'throw')[] = [],
  delayMs = 0,
): FactorFake {
  const calls: { readonly subject: string; readonly factorId: string }[] = [];
  const others: string[] = [];
  const provider: LoginProvider = {
    endSessions: async () => {
      others.push('endSessions');
      return await Promise.resolve({ ok: true, value: undefined });
    },
    deactivate: async () => {
      others.push('deactivate');
      return await Promise.resolve({ ok: true, value: undefined });
    },
    deleteFactor: async (subject, factorId) => {
      calls.push({ subject, factorId });
      await new Promise<void>((done) => {
        setTimeout(done, delayMs);
      });
      const next = script.shift();
      if (next === 'throw') throw new Error(`the provider fell over: ${CANARY}`);
      return next ?? { ok: true, value: undefined };
    },
  };
  return { calls, others, provider };
}

/** A bearer for `subject` on its own provider session, as GoTrue signs one. */
export async function sessionToken(
  subject: string,
  options: {
    readonly sessionId?: string;
    readonly factorAt?: number | null;
    readonly signedInAt?: number;
  } = {},
): Promise<string> {
  const signedInAt = options.signedInAt ?? nowSeconds() - 60;
  const factorAt = options.factorAt === undefined ? signedInAt : options.factorAt;
  return await signBearer({
    sub: subject,
    aud: 'authenticated',
    iss: ACCEPTANCE_ISSUER,
    role: 'authenticated',
    exp: nowSeconds() + 600,
    aal: factorAt === null ? 'aal1' : 'aal2',
    session_id: options.sessionId ?? randomUUID(),
    amr: [
      { method: 'password', timestamp: signedInAt },
      ...(factorAt === null ? [] : [{ method: 'totp', timestamp: factorAt }]),
    ],
  });
}

/** A verified factor for the member, recorded as C59's own acts record one. */
export async function withFactor(
  member: Member,
  businessId: string = harness.world.alpha,
  verified = true,
): Promise<string> {
  const providerFactorId = randomUUID();
  await harness.world.db.app.withBusiness(businessId, async (tx) => {
    const factor = await recordFactorEnrolled(tx, {
      personId: member.personId,
      provider: 'supabase',
      providerFactorId,
    });
    if (!verified) return;
    const subject = member.presented.subject;
    await recordFactorVerified(tx, { personId: member.personId, factorId: factor.id, subject });
  });
  return providerFactorId;
}

export interface Enrolled {
  readonly person: Member;
  readonly factorId: string;
  readonly sessionId: string;
  readonly token: string;
}

/** A teammate with a verified factor, seen here on one `aal2` session. */
export async function memberWithFactor(
  name: string,
  businessId: string = harness.world.alpha,
): Promise<Enrolled> {
  const { person } = await teammate(name, businessId);
  const factorId = await withFactor(person, businessId);
  const sessionId = randomUUID();
  const token = await sessionToken(person.presented.subject, { sessionId });
  const key = businessId === harness.world.bravo ? 'bravo' : 'alpha';
  const seen = await served(token, key);
  if (seen.status !== 200) throw new Error(`memberWithFactor: not served (${seen.code})`);
  return { person, factorId, sessionId, token };
}

/** The subject made bravo's live teammate too (C58's shared login). */
export async function liveInBravo(subject: string): Promise<void> {
  await harness.world.db.app.withBusiness(harness.world.bravo, async (tx) => {
    const personId = await insertPerson(tx, 'shared-in-bravo');
    const actorId = await insertActor(tx, personId);
    await insertMembership(tx, personId);
    await insertMapping(tx, await insertLogin(tx, subject), personId, actorId);
    const member: Member = { personId, actorId, presented: { provider: 'supabase', subject } };
    await grantTo(tx, member, 'read', WHOLE_BUSINESS);
  });
}

export const reset = async (
  api: ReturnType<typeof apiWith>,
  holderId: unknown,
  token?: string,
  key = 'alpha',
): Promise<Answer> =>
  await call(
    api,
    personPath(key, '/access/reset_factor'),
    { operationId: randomUUID(), holderId },
    bearer(token ?? harness.world.ada.token),
  );

/** A read the person could make a minute ago: their own capabilities. */
export const served = async (
  token: string,
  key = 'alpha',
): Promise<{ readonly status: number; readonly code: string }> => {
  const answer = await call(apiWith(), personPath(key, '/session/capabilities'), {}, bearer(token));
  return { status: answer.status, code: answer.code };
};

export interface ResetRow {
  readonly done: boolean;
  readonly attempts: number;
  readonly fault: string | null;
  readonly by: string;
  readonly factor: string;
}

/** What `resetState` reads for one person. */
export interface ResetState {
  readonly factors: readonly string[];
  readonly mirror: boolean | undefined;
  readonly endedHere: readonly string[];
  readonly resets: readonly ResetRow[];
}

/** What a reset touches for one person: their factors, sessions ended, and resets. */
export async function resetState(
  person: Member,
  businessId: string = harness.world.alpha,
): Promise<ResetState> {
  return await harness.world.db.app.withBusiness(businessId, async (tx) => ({
    factors: (
      await tx.query<{ readonly status: string }>(
        'select status from public.second_factors where person_id = $1 order by enrolled_at',
        [person.personId],
      )
    ).map((row) => row.status),
    mirror: (
      await tx.query<{ readonly v: boolean }>(
        'select second_factor_verified as v from public.people where id = $1',
        [person.personId],
      )
    )[0]?.v,
    endedHere: (
      await tx.query<{ readonly session_id: string }>(
        `select session_id::text from public.ended_sessions
          where person_id = $1 and reason = 'factor_change'`,
        [person.personId],
      )
    ).map((row) => row.session_id),
    resets: await tx.query<ResetRow>(
      `select done_at is not null as done, attempts, last_fault as fault,
              reset_by_actor_id::text as by, provider_factor_id as factor
         from public.factor_resets where person_id = $1 order by reset_at`,
      [person.personId],
    ),
  }));
}

/** The money step-up setting, switched through its own command by the owner. */
export async function moneyStepUp(value: boolean): Promise<void> {
  const switched = await call(
    apiWith(),
    personPath('alpha', '/settings/set_money_step_up'),
    { operationId: randomUUID(), value },
    bearer(harness.world.ada.token),
  );
  if (switched.code !== 'ok') throw new Error(`moneyStepUp: refused ${switched.code}`);
}

/** A member reset with no provider at hand: the step is owed. Answers its id. */
export async function owedReset(
  name: string,
): Promise<{ readonly person: Member; readonly factorId: string; readonly id: string }> {
  const member = await memberWithFactor(name);
  const answer = await reset(apiWith(), member.person.personId);
  expect({ status: answer.status, code: answer.code }).toEqual({ status: 200, code: 'ok' });
  const id = String((answer.body['detail'] as Record<string, unknown>)['resetId']);
  return { person: member.person, factorId: member.factorId, id };
}
