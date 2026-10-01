// SPDX-License-Identifier: AGPL-3.0-only
//
// The world `c58-end-access.test.ts` opens: its stand-ins, callers and helpers, split from
// that file to keep it under the line limit. Its hooks are called at module
// level there, under the same skip as its cases.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect } from 'vitest';
import { createApi } from '../../apps/api/app.ts';
import { createSupabaseVerifier } from '../../apps/api/auth/supabase.ts';
import { executeAgentCommand } from '../../packages/core-commands/src/commands/agent-envelope.ts';
import { executeCommand } from '../../packages/core-commands/src/commands/envelope.ts';
import { executeRead } from '../../packages/core-commands/src/reads/execute.ts';
import { type LoginProvider, type ProviderAnswer } from '../../packages/core-commands/src/index.ts';
import { ACCEPTANCE_ISSUER, tokenFor } from '../acceptance/cast.ts';
import { createHarness, type Harness } from '../acceptance/role-case-harness.ts';
import { bearer, call, personPath, serverUrl, type Answer } from '../acceptance/world.ts';
import {
  enrol,
  grantTo,
  shareWithClient,
  WHOLE_BUSINESS,
  type Member,
} from '../commands/fixture.ts';
import { signBearer, testSignIn } from '../support/sign-in.ts';

export const CANARY = 'CANARY-c58-end-access-4be91c';

if (serverUrl === undefined) {
  console.warn('authority/c58-end-access: DATABASE_URL is unset, so nothing below ran.');
}

export type Step = 'endSessions' | 'deactivate';
export type Scripted = ProviderAnswer<void> | 'throw';

/** A provider that answers from a script, step by step, and records every call. */
/** What `scripted` hands back: the calls it saw and the provider that saw them. */
export interface ScriptedProvider {
  readonly calls: { readonly step: Step; readonly subject: string }[];
  readonly provider: LoginProvider;
}

export function scripted(script: Partial<Record<Step, Scripted[]>> = {}): ScriptedProvider {
  const calls: { readonly step: Step; readonly subject: string }[] = [];
  const answer = (step: Step, subject: string): Promise<ProviderAnswer<void>> => {
    calls.push({ step, subject });
    const next = script[step]?.shift();
    if (next === 'throw') return Promise.reject(new Error(`the provider fell over: ${CANARY}`));
    return Promise.resolve(next ?? { ok: true, value: undefined });
  };
  const provider: LoginProvider = {
    endSessions: async (subject) => await answer('endSessions', subject),
    deactivate: async (subject) => await answer('deactivate', subject),
  };
  return { calls, provider };
}

export const FAIL: ProviderAnswer<void> = { ok: false, fault: 'unreachable' };

export const outcome = (answer: Answer): { readonly status: number; readonly code: string } => ({
  status: answer.status,
  code: answer.code,
});

export const nowSeconds = (): number => Math.floor(Date.now() / 1000);

/** A GoTrue-shaped bearer whose first sign-in was `signedInAt`. */
export async function signedIn(
  subject: string,
  signedInAt: number | null,
  iat: number = nowSeconds(),
): Promise<string> {
  return await signBearer({
    sub: subject,
    aud: 'authenticated',
    iss: ACCEPTANCE_ISSUER,
    role: 'authenticated',
    iat,
    exp: iat + 3600,
    // `amr: undefined` signs a bearer with no first-sign-in time at all.
    amr: signedInAt === null ? undefined : [{ method: 'password', timestamp: signedInAt }],
  });
}

/** A read the person could make yesterday: their own capabilities. */
export const ownCall = async (
  api: ReturnType<typeof createApi>,
  token: string,
  key = 'alpha',
): Promise<Answer> => await call(api, personPath(key, '/session/capabilities'), {}, bearer(token));

export let harness: Harness;
export let clientToken: string;
export let credential: string;

export const apiWith = (logins?: LoginProvider, now?: () => number): ReturnType<typeof createApi> =>
  createApi({
    database: harness.world.db.app,
    verify: createSupabaseVerifier({
      ...testSignIn(ACCEPTANCE_ISSUER),
      ...(now === undefined ? {} : { now }),
    }),
    resolveBusiness: (key: string) =>
      Promise.resolve({ alpha: harness.world.alpha, bravo: harness.world.bravo }[key]),
    executeCommand,
    executeRead,
    executeAgentCommand,
    ...(logins === undefined ? {} : { logins }),
  });

export const end = async (
  api: ReturnType<typeof apiWith>,
  holderId: unknown,
  token?: string,
  key = 'alpha',
): Promise<Answer> =>
  await call(
    api,
    personPath(key, '/access/end'),
    { operationId: randomUUID(), holderId },
    bearer(token ?? harness.world.ada.token),
  );

/** A teammate of `businessId` with a task grant, one over a client, and a delegation. */
export const teammate = async (
  name: string,
  businessId: string = harness.world.alpha,
): Promise<{ readonly person: Member; readonly token: string }> => {
  const person = await enrol(
    harness.world.db.app,
    businessId,
    `${name}-${randomUUID().slice(0, 6)}`,
  );
  await harness.world.db.app.withBusiness(businessId, async (tx) => {
    await grantTo(tx, person, 'write', WHOLE_BUSINESS);
    await grantTo(tx, person, 'read', WHOLE_BUSINESS);
  });
  return { person, token: await signedIn(person.presented.subject, nowSeconds() - 60) };
};

/** The rows `access.end` touches for one person, to show what changed. */
/** What `stateOf` reads for one person. */
export interface PersonState {
  readonly liveGrants: number;
  readonly liveDelegations: number;
  readonly activeMemberships: number;
  readonly activeActors: number;
  readonly endings: readonly {
    readonly sessions: boolean;
    readonly login: boolean;
    readonly attempts: number;
    readonly fault: string | null;
    readonly by: string;
  }[];
}

export const stateOf = async (
  person: Member,
  businessId: string = harness.world.alpha,
): Promise<PersonState> =>
  await harness.world.db.app.withBusiness(businessId, async (tx) => {
    const one = async (sql: string) =>
      (await tx.query<{ readonly n: number }>(sql, [person.personId]))[0]?.n ?? -1;
    return {
      liveGrants: await one(
        `select count(*)::int as n from public.grants
          where subject_kind = 'person' and subject_id = $1 and revoked_at is null`,
      ),
      liveDelegations: await one(
        `select count(*)::int as n from public.delegations
          where delegate_person_id = $1 and revoked_at is null and settled_at is null`,
      ),
      activeMemberships: await one(
        `select count(*)::int as n from public.memberships where person_id = $1 and active`,
      ),
      activeActors: await one(
        `select count(*)::int as n from public.actors where person_id = $1 and active`,
      ),
      endings: await tx.query<{
        readonly sessions: boolean;
        readonly login: boolean;
        readonly attempts: number;
        readonly fault: string | null;
        readonly by: string;
      }>(
        `select sessions_ended_at is not null as sessions,
                login_deactivated_at is not null as login,
                attempts, last_fault as fault, ended_by_actor_id::text as by
           from public.access_endings where person_id = $1`,
        [person.personId],
      ),
    };
  });

export async function openEndAccessWorld(): Promise<void> {
  harness = await createHarness('c58_access_end');
  const { world } = harness;
  await world.db.app.withBusiness(world.bravo, async (tx) => {
    await grantTo(tx, world.bea as unknown as Member, 'manage', WHOLE_BUSINESS, false, 'access');
  });
  const client = await shareWithClient(
    world.db.app,
    world.alpha,
    world.ada as unknown as Member,
    harness.alphaTask.id,
  );
  clientToken = await tokenFor(client.presented.subject);
  const { decided } = await harness.approvedReservation();
  expect(decided.code, 'the decision a pickup needs').toBe('ok');
  const reservationId = (decided.body['detail'] as Record<string, unknown>)['reservationId'];
  const picked = await harness.asAgent('task.pickup', { reservationId });
  expect(picked.code, 'the pickup').toBe('ok');
  credential = String((picked.body['detail'] as Record<string, unknown>)['credential']);
}

export async function closeEndAccessWorld(): Promise<void> {
  await harness?.close();
}

/** The hooks a test file opening this world calls at module level, under its cases' skip. */
export function useEndAccessWorld(): void {
  beforeAll(async () => {
    if (serverUrl === undefined) return;
    await openEndAccessWorld();
  }, 120_000);
  afterAll(async () => {
    if (serverUrl === undefined) return;
    await closeEndAccessWorld();
  });
}
