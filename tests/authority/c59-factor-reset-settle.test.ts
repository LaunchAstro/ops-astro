// SPDX-License-Identifier: AGPL-3.0-only
//
// C59 (ORCH65-Q3): the provider step a factor reset owes, and the check that
// refuses a login live elsewhere. The adapter's own cases are in
// `c59-factor-reset-adapter.test.ts`.
//
// After the reset commits, the local server (where it holds the admin key)
// and the endings loop (the only hosted holder of `SUPABASE_SERVICE_KEY`) send
// GoTrue's admin removal, `DELETE /admin/users/<subject>/factors/<id>`. A
// claim stops two settles calling at once; done is stamped once and never
// asked again; a fault is kept by its kind alone. The live-elsewhere check is
// a definer function answering a boolean, which PUBLIC may not execute.

import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { retryOwedSteps } from '../../apps/endings/pass.ts';
import { settleFactorResets, type LoginProvider } from '../../packages/core-commands/src/index.ts';
import { serverUrl } from '../acceptance/world.ts';
import type { Member } from '../commands/fixture.ts';
import { apiWith, harness, outcome, useEndAccessWorld } from './c58-end-access-world.ts';
import {
  CANARY,
  factorFake,
  liveInBravo,
  memberWithFactor,
  reset,
  resetState,
} from './c59-factor-reset-world.ts';

useEndAccessWorld();

const OK = { status: 200, code: 'ok' };

const settle = async (provider: LoginProvider, only?: readonly string[], claimSeconds = 0) =>
  await settleFactorResets(harness.world.db.app, harness.world.alpha, provider, {
    claimSeconds,
    ...(only === undefined ? {} : { only }),
  });

/** A member reset with no provider at hand: the step is owed. Answers its id. */
async function owedReset(name: string): Promise<{ person: Member; factorId: string; id: string }> {
  const member = await memberWithFactor(name);
  const answer = await reset(apiWith(), member.person.personId);
  expect(outcome(answer)).toEqual(OK);
  const id = String((answer.body['detail'] as Record<string, unknown>)['resetId']);
  return { person: member.person, factorId: member.factorId, id };
}

const doneAt = async (person: Member): Promise<string | null> =>
  (
    await harness.world.db.app.withBusiness(
      harness.world.alpha,
      async (tx) =>
        await tx.query<{ readonly at: string | null }>(
          'select done_at::text as at from public.factor_resets where person_id = $1',
          [person.personId],
        ),
    )
  )[0]?.at ?? null;

async function settlesOnceThenNothing(): Promise<void> {
  const { calls, others, provider } = factorFake();
  const member = await memberWithFactor('sol');
  const answer = await reset(apiWith(provider), member.person.personId);
  expect(outcome(answer)).toEqual(OK);
  expect((answer.body['detail'] as Record<string, unknown>)['providerStep']).toBe('done');
  const subject = member.person.presented.subject;
  expect(calls).toEqual([{ subject, factorId: member.factorId }]);
  expect(others).toEqual([]);
  const stamped = await doneAt(member.person);
  expect(stamped).not.toBeNull();
  expect((await resetState(member.person)).resets).toEqual([
    expect.objectContaining({ done: true, attempts: 1, fault: null }),
  ]);

  // Asked again, nothing is sent and the stamp stands.
  await settle(provider);
  expect(calls).toHaveLength(1);
  expect(await doneAt(member.person)).toBe(stamped);
}

async function twoSettlesAtOnce(): Promise<void> {
  const owed = await owedReset('tam');
  const { calls, provider } = factorFake([], 300);
  const [first, second] = await Promise.all([
    settle(provider, [owed.id], 30),
    settle(provider, [owed.id], 30),
  ]);
  expect(calls).toHaveLength(1);
  expect(first.attempted + second.attempted).toBe(1);
  expect((await resetState(owed.person)).resets).toEqual([
    expect.objectContaining({ done: true, attempts: 1 }),
  ]);
}

async function faultKeptByKind(): Promise<void> {
  const owed = await owedReset('uli');
  const { calls, provider } = factorFake(['throw', { ok: false, fault: 'slow' }]);
  await settle(provider, [owed.id]);
  expect((await resetState(owed.person)).resets).toEqual([
    expect.objectContaining({ done: false, attempts: 1, fault: 'unreachable' }),
  ]);
  await settle(provider, [owed.id]);
  expect((await resetState(owed.person)).resets).toEqual([
    expect.objectContaining({ done: false, attempts: 2, fault: 'slow' }),
  ]);
  const rows = await harness.world.db.app.withBusiness(
    harness.world.alpha,
    async (tx) =>
      await tx.query<{ readonly row: string }>(
        'select to_jsonb(r)::text as row from public.factor_resets r where id = $1',
        [owed.id],
      ),
  );
  expect(rows[0]?.row).not.toContain(CANARY);
  // The next answer that holds is the one stamped, and the fault is cleared.
  await settle(provider, [owed.id]);
  expect((await resetState(owed.person)).resets).toEqual([
    expect.objectContaining({ done: true, attempts: 3, fault: null }),
  ]);
  expect(calls).toHaveLength(3);
}

async function endingsPassSettles(): Promise<void> {
  const owed = await owedReset('vee');
  const { calls, provider } = factorFake();
  const from = harness.world.db.admin.log.entries.length;
  expect(await retryOwedSteps(harness.world.db.admin, harness.world.db.app, provider, 0)).toBe(0);
  expect(calls).toContainEqual({
    subject: owed.person.presented.subject,
    factorId: owed.factorId,
  });
  const since = harness.world.db.admin.log.entries.slice(from);
  const owner = since.filter((each) => each.source === 'migration').map((each) => each.text);
  expect(owner.every((text) => text.trim().toLowerCase().startsWith('select'))).toBe(true);
  expect((await resetState(owed.person)).resets).toEqual([
    expect.objectContaining({ done: true, fault: null }),
  ]);
}

async function canaryNeverLeaks(): Promise<void> {
  const logged: string[] = [];
  const capture = (...parts: unknown[]) => void logged.push(parts.map(String).join(' '));
  const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((level) =>
    vi.spyOn(console, level).mockImplementation(capture),
  );
  const member = await memberWithFactor(`wyn-${CANARY}`);
  try {
    const api = apiWith(factorFake(['throw']).provider);
    const answers = [
      await reset(api, CANARY),
      await reset(api, `${randomUUID()}${CANARY}`),
      await reset(api, member.person.personId, harness.world.noah.token),
      await reset(api, member.person.personId),
    ];
    expect(answers.slice(0, 3).every((answer) => answer.status >= 400)).toBe(true);
    expect(answers[3]?.code).toBe('ok');
    for (const answer of answers) expect(JSON.stringify(answer.body)).not.toContain(CANARY);
  } finally {
    for (const spy of spies) spy.mockRestore();
  }
  expect(logged.join('\n')).not.toContain(CANARY);
  const stored = await harness.world.db.app.withBusiness(
    harness.world.alpha,
    async (tx) =>
      await tx.query<{ readonly row: string }>(
        `select to_jsonb(e)::text as row from public.audit_events e
          where command = 'access.reset_factor'
         union all select to_jsonb(o)::text from public.operations o
         union all select to_jsonb(r)::text from public.factor_resets r`,
      ),
  );
  expect(stored.length).toBeGreaterThan(0);
  expect(stored.map((each) => each.row).join('\n')).not.toContain(CANARY);
}

const SIGNATURE = 'public.factor_login_live_elsewhere(text)';

async function definerNotPublic(): Promise<void> {
  const { admin } = harness.world.db;
  const [granted] = await admin.execute<{
    readonly anyone: boolean;
    readonly app: boolean;
    readonly definer: boolean;
    readonly returns: string;
    readonly config: readonly string[];
  }>(
    `select has_function_privilege('public', $1, 'execute') as anyone,
            has_function_privilege('ops_astro_app', $1, 'execute') as app,
            p.prosecdef as definer, p.prorettype::regtype::text as returns, p.proconfig as config
       from pg_proc p where p.oid = $1::regprocedure`,
    [SIGNATURE],
  );
  expect(granted).toEqual({
    anyone: false,
    app: true,
    definer: true,
    returns: 'boolean',
    config: ['search_path=pg_catalog, public', 'row_security=off'],
  });
  // A role granted nothing of its own is refused the call itself.
  const nobody = `c59_nobody_${randomUUID().slice(0, 8)}`;
  await admin.execute(`create role ${nobody} nologin`);
  await admin.execute(`grant usage on schema public to ${nobody}`);
  try {
    const called = admin.transaction(async (execute) => {
      await execute(`set local role ${nobody}`);
      return await execute(`select public.factor_login_live_elsewhere('x') as live`);
    });
    await expect(called).rejects.toMatchObject({ code: '42501' });
    await expect(called).rejects.toThrow(/function/u);
  } finally {
    await admin.execute(`revoke usage on schema public from ${nobody}`);
    await admin.execute(`drop role ${nobody}`);
  }
}

/** The definer's answer for `subject`, asked inside alpha's tenancy on the app login. */
const askInAlpha = async (subject: string): Promise<readonly Record<string, unknown>[]> =>
  await harness.world.db.app.withBusiness(
    harness.world.alpha,
    async (tx) =>
      await tx.query<Record<string, unknown>>(
        'select public.factor_login_live_elsewhere($1) as live',
        [subject],
      ),
  );

async function definerAnswersBoolean(): Promise<void> {
  const shared = await memberWithFactor('xi');
  await liveInBravo(shared.person.presented.subject);
  const alone = await memberWithFactor('yo');
  expect(await askInAlpha(shared.person.presented.subject)).toEqual([{ live: true }]);
  expect(await askInAlpha(alone.person.presented.subject)).toEqual([{ live: false }]);
  // With no business set, the answer refuses.
  const [unset] = await harness.world.db.admin.execute<{ readonly live: boolean }>(
    `select public.factor_login_live_elsewhere($1) as live`,
    [alone.person.presented.subject],
  );
  expect(unset).toEqual({ live: true });
}

describe.skipIf(serverUrl === undefined)("C59 a reset's provider step", () => {
  it(
    'C59 settle: one admin DELETE is sent and stamped done once; a second settle sends nothing',
    settlesOnceThenNothing,
  );
  it('C59 settle: two settles at once call the provider once', twoSettlesAtOnce);
  it('C59 settle: a provider fault keeps the step owed with its kind alone', faultKeptByKind);
  it('C59 settle: the endings pass settles owed reset steps', endingsPassSettles);
  it(
    'C59 canary: a planted secret marker never reaches a log, answer, audit, operation or reset row',
    canaryNeverLeaks,
  );
  it(
    'C59 definer: factor_login_live_elsewhere is not executable by PUBLIC, only by the app role, pinned',
    definerNotPublic,
  );
  it(
    'C59 definer: it answers a boolean alone, and true with no business set',
    definerAnswersBoolean,
  );
});
