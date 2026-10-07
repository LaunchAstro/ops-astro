// SPDX-License-Identifier: AGPL-3.0-only
//
// What c71-d-authority-under-locks.test.ts shares: the seeded member bundle as
// the seed declares it, and a write held on a real advisory lock while the
// world changes underneath it.
// oxlint-disable no-await-in-loop -- clock steps and held-lock interleavings are sequential.
import { readFileSync } from 'node:fs';
import { advisoryLock, connect } from '../../packages/core-records/src/tenancy/database.ts';
import type { Action } from '../../packages/core-records/src/authority/grants.ts';
import type { ChatWorld } from './c71-d-world.ts';
import type { Caller } from '../acceptance/cast.ts';
import type { Answer } from '../acceptance/world.ts';

export const CHAT = { membership: true, actions: ['comment'], collections: ['chat'] } as const;

export function seededMemberPairs(): readonly (readonly [string, Action])[] {
  // Same source-data reader as seeded-role-grants.test.ts. The seed runs on
  // import, so evaluate its constant table alone and validate the result.
  const source = readFileSync('scripts/local-seed.mjs', 'utf8');
  const prefix = 'const GRANTS_BY_ROLE = ';
  const start = source.indexOf(`${prefix}{`);
  const end = source.indexOf('\n};\n', start);
  if (start < 0 || end < 0) throw new Error('seed grant table absent');
  const value: unknown = new Function(
    `return (${source.slice(start + prefix.length, end + 2)});`,
  )();
  if (
    typeof value !== 'object' ||
    value === null ||
    !('member' in value) ||
    !Array.isArray(value.member)
  ) {
    throw new Error('seed member bundle malformed');
  }
  return value.member.map((entry: unknown) => {
    if (!Array.isArray(entry) || entry.length !== 2) throw new Error('seed pair malformed');
    const collection: unknown = entry[0];
    const action: unknown = entry[1];
    if (typeof collection !== 'string' || !isAction(action)) throw new Error('seed pair invalid');
    return [collection, action] as const;
  });
}

function isAction(value: unknown): value is Action {
  return (
    typeof value === 'string' &&
    ['read', 'comment', 'write', 'assign', 'decide', 'share', 'manage'].includes(value)
  );
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
