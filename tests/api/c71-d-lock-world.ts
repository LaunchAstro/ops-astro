// SPDX-License-Identifier: AGPL-3.0-only
//
// What c71-d-authority-under-locks.test.ts shares: the seeded member bundle as
// the seed declares it, and a write held on a real advisory lock while the
// world changes underneath it.
// oxlint-disable no-await-in-loop -- clock steps and held-lock interleavings are sequential.
import { advisoryLock, connect } from '../../packages/core-records/src/tenancy/database.ts';
import type { Action } from '../../packages/core-records/src/authority/grants.ts';
import type { ChatWorld } from './c71-d-world.ts';
import type { Caller } from '../acceptance/cast.ts';
import { GRANTS_BY_ROLE } from '../../scripts/local-seed-roles.ts';
import type { Answer } from '../acceptance/world.ts';

export const CHAT = { membership: true, actions: ['comment'], collections: ['chat'] } as const;

export function seededMemberPairs(): readonly (readonly [string, Action])[] {
  // The seed's member bundle, imported from the module the seed takes it from.
  return GRANTS_BY_ROLE.member;
}

export function idOf(answer: Answer): string {
  const detail = answer.body['detail'];
  if (typeof detail !== 'object' || detail === null || !('conversationId' in detail)) {
    throw new Error(`no conversation in ${answer.text}`);
  }
  return String(detail.conversationId);
}

function noop(): void {}

function signal() {
  let fire: () => void = noop;
  const fired = new Promise<void>((resolve) => {
    fire = resolve;
  });
  return { fired, fire };
}

async function waitForAdvisoryWait(chat: ChatWorld): Promise<void> {
  const { db } = chat.harness.world;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    // This observes a real blocked server statement, rather than guessing a delay.
    const rows = await db.admin.execute<{ readonly n: number }>(
      `select count(*)::int as n from pg_stat_activity
        where usename = $1 and wait_event = 'advisory'
          and query like 'select pg_advisory_xact_lock%'`,
      [db.loginRole],
    );
    if ((rows[0]?.n ?? 0) > 0) return;
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 10);
    });
  }
  throw new Error('write never reached the held advisory lock');
}

export async function writeAcrossChange(
  chat: ChatWorld,
  lockKey: string,
  invoke: () => Promise<Answer>,
  change: () => Promise<void>,
): Promise<Answer> {
  const { world } = chat.harness;
  const own = connect(world.db.appUrl);
  const held = signal();
  const release = signal();
  const holding = own.withBusiness(world.alpha, async (tx) => {
    await advisoryLock(tx, lockKey);
    held.fire();
    await release.fired;
  });
  await held.fired;
  const sending = invoke();
  try {
    await waitForAdvisoryWait(chat);
    await change();
  } finally {
    release.fire();
    await holding;
    await own.close();
  }
  return await sending;
}

export async function sendAcrossChange(
  chat: ChatWorld,
  from: Caller,
  to: Caller,
  body: string,
  change: () => Promise<void>,
): Promise<Answer> {
  const pair = [from.personId, to.personId].toSorted().join(':');
  return await writeAcrossChange(
    chat,
    `chat.direct:${chat.harness.world.alpha}:${pair}`,
    async () => await chat.send(from, to, body),
    change,
  );
}
