// SPDX-License-Identifier: AGPL-3.0-only
//
// `AW-04 set planning cap` (U10, ORCH43 on BUILDABLE-SCAN-4 (b)1): the command
// that sets a business's planning cap, `budget.set_planning_cap`. `decide` on
// `billing` for the whole business (owners and administrators), never an agent;
// audited by the envelope; checked against the limit the caller last saw
// (`fromLimitMinor`), under the cap row's lock. It writes the `budget_caps` row
// keyed `planning` and nothing else, and the planning broker reads what it
// wrote. Until a person sets it the cap is the default, AUD 50, and that is
// the limit a caller has seen.
//
// A money action, so it is in the step-up set: AW-04 set planning cap: a
// sign-in older than the money step-up window is refused before any write
// (LEANS-ON C59, family B; written here at the batch rebase).

import { randomUUID } from 'node:crypto';
import { beforeAll, expect, it as vitestIt } from 'vitest';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import type { AdminConnection } from '../../packages/core-records/src/index.ts';
import { enrol, grantTo, type Member } from '../commands/fixture.ts';
import {
  asAgent,
  asPerson,
  codeOf,
  createTask,
  racer,
  type Schedules,
} from '../runtime/schedules-harness.ts';
import { cq8World } from '../runtime/t2d-harness.ts';
import { executeCommand } from '../../packages/core-commands/src/commands/envelope.ts';
import type { CommandResult } from '../../packages/core-commands/src/commands/register-store.ts';
import { noDatabase, s, world } from './broker-world.ts';
import { allowance, ask, ownerOf, p, plan, usePlanningWorld } from './aw-04-planning-world.ts';

const it = noDatabase ? vitestIt.skip : vitestIt;

usePlanningWorld('aw04setcap');
// Each business's decider holds `billing:decide` on the whole business: its owner.
beforeAll(async () => {
  if (noDatabase) return;
  for (const on of [s, p.bravo]) {
    // eslint-disable-next-line no-await-in-loop
    await on.db.app.withBusiness(on.business, async (tx) => {
      await grantTo(tx, on.decider, 'decide', undefined, false, 'billing');
    });
  }
});

const setBody = (
  limitMinor: unknown,
  fromLimitMinor: unknown,
  extra: Readonly<Record<string, unknown>> = {},
): Readonly<Record<string, unknown>> => ({
  command: 'budget.set_planning_cap',
  operationId: randomUUID(),
  limitMinor,
  currency: 'AUD',
  fromLimitMinor,
  ...extra,
});

/** Every cap row of the business, by key. */
async function caps(on: Schedules): Promise<Record<string, string>> {
  const found = await on.db.admin.execute<{ key: string; limit_minor: string }>(
    `select key, limit_minor::text from public.budget_caps where business_id = $1`,
    [on.business],
  );
  return Object.fromEntries(found.map((row) => [row.key, row.limit_minor]));
}

/** Resolves once `count` backends in this database wait on a lock. */
async function waiting(execute: AdminConnection['execute'], count: number): Promise<void> {
  for (let tries = 0; tries < 200; tries += 1) {
    // eslint-disable-next-line no-await-in-loop
    await execute('select pg_stat_clear_snapshot()');
    // eslint-disable-next-line no-await-in-loop
    const [row] = await execute<{ n: string }>(
      `select count(*)::text as n from pg_stat_activity
        where datname = current_database() and wait_event_type = 'Lock'`,
    );
    if (Number(row?.n) >= count) return;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => {
      setTimeout(resolve, 25);
    });
  }
  throw new Error('the two setters never met');
}

it('AW-04 set planning cap: a billing holder moves the default AUD 50 cap, the broker spends under it, and a lower cap refuses the next reply', async () => {
  expect((await caps(s))['planning']).toBeUndefined();
  // The default is the limit there is to have seen; nothing is unset.
  const unseen = await asPerson(s, setBody(1_200, null));
  expect(unseen).toMatchObject({ code: 'VERSION_STALE', names: ['limitMinor=5000'] });
  expect((await caps(s))['planning']).toBeUndefined();
  const first = await asPerson(s, setBody(1_200, 5_000));
  expect(codeOf(first)).toBe('applied');
  if (isCommandRefusal(first)) return;
  expect(first.detail).toStrictEqual({ key: 'planning', limitMinor: 1_200, currency: 'AUD' });
  expect(await caps(s)).toStrictEqual({ local: '1000000', planning: '1200' });

  const request = ask(s);
  expect(await allowance(s, s.decider.personId, request.conversation.id)).toMatchObject({
    set: true,
    currency: 'AUD',
    limitMinor: 1_200,
    leftMinor: 1_200,
  });
  world.provider.mode('answer');
  const reply = await plan(s, ownerOf(s), request);
  expect(reply).toMatchObject({ ok: true, reservedMinor: 500 });
  const spent = reply.ok ? reply.actualMinor : -1;

  // Below what one more reply's maximum needs: the cap is lowered, and the
  // next reply is refused with nothing written or sent.
  const lowered = await asPerson(s, setBody(spent + 499, 1_200));
  expect(codeOf(lowered)).toBe('applied');
  expect(await caps(s)).toStrictEqual({ local: '1000000', planning: String(spent + 499) });
  const sent = world.provider.seen.length;
  expect(await plan(s, ownerOf(s), request)).toMatchObject({ code: 'BUDGET_UNAVAILABLE' });
  expect(world.provider.seen.length).toBe(sent);
  // Below what is already committed: accepted, and nothing is left.
  expect(codeOf(await asPerson(s, setBody(1, spent + 499)))).toBe('applied');
  expect(await allowance(s, s.decider.personId, request.conversation.id)).toMatchObject({
    limitMinor: 1,
    leftMinor: 0,
  });

  const events = await s.db.admin.execute<{ outcome: string }>(
    `select outcome from public.audit_events
      where business_id = $1 and command = 'budget.set_planning_cap' and actor_id = $2`,
    [s.business, s.decider.actorId],
  );
  expect(events.map((event) => event.outcome)).toStrictEqual([
    'refused',
    'applied',
    'applied',
    'applied',
  ]);
});

it('AW-04 set planning cap: a limit the caller did not last see is refused VERSION_STALE naming the one it is at, and the row keeps it', async () => {
  const [row] = await s.db.admin.execute<{ limit_minor: string }>(
    `select limit_minor::text from public.budget_caps where business_id = $1 and key = 'planning'`,
    [s.business],
  );
  const current = Number(row?.limit_minor);
  for (const seen of [null, current + 1]) {
    // eslint-disable-next-line no-await-in-loop
    const stale = await asPerson(s, setBody(9_000, seen));
    expect(stale).toMatchObject({ code: 'VERSION_STALE', names: [`limitMinor=${current}`] });
  }
  expect((await caps(s))['planning']).toBe(String(current));
  const refusals = await s.db.admin.execute<{ refusal_code: string }>(
    `select refusal_code from public.audit_events
      where business_id = $1 and command = 'budget.set_planning_cap' and outcome = 'refused'`,
    [s.business],
  );
  expect(refusals.map((event) => event.refusal_code)).toContain('VERSION_STALE');
});

it('AW-04 set planning cap: the amount, the currency, the limit seen and any other field are refused by name, and nothing is written', async () => {
  const cases: readonly [Readonly<Record<string, unknown>>, string, string][] = [
    [setBody(0, null), 'FIELD_VALUE_INVALID', 'limitMinor'],
    [setBody(-5, null), 'FIELD_VALUE_INVALID', 'limitMinor'],
    [setBody(1.5, null), 'FIELD_VALUE_INVALID', 'limitMinor'],
    [setBody(2 ** 53, null), 'FIELD_VALUE_INVALID', 'limitMinor'],
    [setBody('500', null), 'FIELD_VALUE_INVALID', 'limitMinor'],
    [setBody(500, 0), 'FIELD_VALUE_INVALID', 'fromLimitMinor'],
    [setBody(500, null, { currency: 'USD' }), 'FIELD_VALUE_INVALID', 'currency'],
    [setBody(500, null, { currency: 'aud' }), 'FIELD_VALUE_INVALID', 'currency'],
    [setBody(500, null, { key: 'local' }), 'FIELD_NOT_WRITABLE', 'key'],
    [setBody(500, null, { recordId: p.bravo.capId }), 'COMMAND_BODY_INVALID', 'recordId'],
  ];
  for (const [body, code, name] of cases) {
    // eslint-disable-next-line no-await-in-loop
    const refused = await asPerson(p.bravo, body);
    expect([name, codeOf(refused)]).toStrictEqual([name, code]);
    expect(isCommandRefusal(refused) ? refused.names.join(' ') : '').toContain(name);
  }
  expect(await caps(p.bravo)).toStrictEqual({ local: '1000000' });
});

it('AW-04 set planning cap: two setters at once from the same limit, on two connections: one applies, the other is refused VERSION_STALE', async () => {
  const bravo = p.bravo;
  // The first two meet on the default cap (the unique key), the next two on its row lock.
  for (const [from, mine, theirs] of [
    [5_000, 700, 800],
    [700, 900, 1_000],
  ] as const) {
    const other = racer(bravo);
    try {
      // eslint-disable-next-line no-await-in-loop
      const both = await bravo.db.admin.transaction(async (execute) => {
        await execute('lock table public.budget_caps in exclusive mode');
        const racing = Promise.all([
          asPerson(bravo, setBody(mine, from)),
          asPerson(bravo, setBody(theirs, from), other),
        ]);
        await waiting(execute, 2);
        return { racing };
      });
      // eslint-disable-next-line no-await-in-loop
      const codes = (await both.racing).map((result) => codeOf(result));
      expect(codes.toSorted()).toStrictEqual(['VERSION_STALE', 'applied']);
      const won = codes[0] === 'applied' ? mine : theirs;
      // eslint-disable-next-line no-await-in-loop
      expect((await caps(bravo))['planning']).toBe(String(won));
      // eslint-disable-next-line no-await-in-loop
      if (won !== 700 && from === 5_000) await asPerson(bravo, setBody(700, won));
    } finally {
      // eslint-disable-next-line no-await-in-loop
      await other.close();
    }
  }
});

it('AW-04 set planning cap isolation: another business, another client, another person under a live delegation', async () => {
  // Alpha's cap at a planted amount no crossing may see.
  const [row] = await s.db.admin.execute<{ id: string }>(
    `insert into public.budget_caps (business_id, id, key, limit_minor, currency)
     values ($1, $2, 'planning', 7319, 'AUD')
     on conflict (business_id, key) do update set limit_minor = 7319
     returning id`,
    [s.business, randomUUID()],
  );
  const before = await caps(s);
  const foreign = new RegExp(`${s.business}|${String(row?.id)}|7319|${s.capId}`, 'u');
  const credential = String(p.work.picked['credential']);
  const answers = [
    // 1. Another business: bravo's billing owner, presenting in alpha, and in its own.
    [await inAlpha(p.bravo.decider), 'AUTH_NO_MEMBERSHIP'],
    [await asPerson(p.bravo, setBody(9_999, 7_319)), 'VERSION_STALE'],
    // 2. Another client of the business, and 3. other people: a member with no
    // billing grant, one holding it on a single task, and the world's agent
    // under its pickup's live delegation.
    ...(await clientAndPeople()),
    [await asAgent(s, setBody(9_999, 7_319), credential), 'DELEGATION_EXCLUDES_OPERATION'],
  ] as const;
  expect(answers.map(([answer]) => codeOf(answer))).toStrictEqual(answers.map(([, code]) => code));
  expect(await caps(s)).toStrictEqual(before);
  expect(JSON.stringify(answers)).not.toMatch(foreign);
  expect(JSON.stringify(answers)).not.toContain(credential);
  // The delegation the agent presented is live: not revoked, settled or expired.
  const [live] = await s.db.admin.execute<{ n: string }>(
    `select count(*)::text as n from public.leases l
       join public.delegations d on d.business_id = l.business_id and d.id = l.delegation_id
      where l.id = $1 and d.revoked_at is null and d.settled_at is null and d.expires_at > now()`,
    [p.work.picked['leaseId']],
  );
  expect(live?.n).toBe('1');
  // The positive control: alpha's own billing holder sets it from what it holds.
  expect(codeOf(await asPerson(s, setBody(7_320, 7_319)))).toBe('applied');
}, 120_000);

/** A signed-in caller presenting in alpha, asking to raise alpha's planted cap. */
async function inAlpha(member: Member): Promise<CommandResult> {
  const body = setBody(9_999, 7_319) as never;
  return await executeCommand(s.db.app, s.business, member.presented, 'api', body);
}

async function clientAndPeople(): Promise<(readonly [CommandResult, string])[]> {
  await s.db.app.withBusiness(s.business, async (tx) => {
    await grantTo(tx, s.decider, 'share');
  });
  const task = await createTask(s, 'aw04setcap client task');
  const client = await cq8World(s).client(s.business, s.decider, 'aw04sc', task);
  const plain = await enrol(s.db.app, s.business, 'aw04setcap-plain');
  const scoped = await enrol(s.db.app, s.business, 'aw04setcap-scoped');
  await s.db.app.withBusiness(s.business, async (tx) => {
    await grantTo(tx, scoped, 'decide', { kind: 'record', id: task }, false, 'billing');
  });
  const answers: (readonly [CommandResult, string])[] = [];
  for (const member of [client, plain, scoped]) {
    // eslint-disable-next-line no-await-in-loop
    answers.push([await inAlpha(member), 'SCOPE_NOT_GRANTED']);
  }
  return answers;
}
