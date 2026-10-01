// SPDX-License-Identifier: AGPL-3.0-only
//
// C40, the ask's asks in flight: `POST /api/password/reset` drops, in memory
// and before the database, an ask from a client address past
// `RESET_SOURCE_LIMIT` or with an ask of its own still on the database, then
// one past `RESET_IN_FLIGHT` asks on the database, and holds that slot for
// the database work only, never while the provider is asked. The database
// and custody are stand-ins: a blocking database holds a flood from many
// sources to the cap, a slow one shows one source's flood leaving another's
// ask served, and a slow provider for known addresses shows the slot says
// nothing about whether an account exists. No real database is needed.

import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { enrolmentBroker } from '../../apps/api/enrolment-broker.ts';
import {
  mountPasswordReset,
  PASSWORD_RESET_PATH,
  RESET_IN_FLIGHT,
} from '../../apps/api/password-set.ts';
import { RESET_SOURCE_LIMIT } from '../../packages/core-commands/src/index.ts';
import type { Custody } from '../../packages/core-custody/src/index.ts';
import type { Database } from '../../packages/core-records/src/index.ts';

const wait = async (ms: number): Promise<void> => {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
};

/** A database under every limit, each transaction after `delay`; each statement counted. */
function underLimits(delay = 0): { database: Database; statements: unknown[] } {
  const statements: unknown[] = [];
  const query = async (text: string): Promise<unknown[]> => {
    statements.push(text);
    return await Promise.resolve([{ source: 0, asks: 0, mails: 0 }]);
  };
  const database = {
    withBusiness: async (_business: string, run: (tx: unknown) => Promise<unknown>) => {
      if (delay > 0) await wait(delay);
      return await run({ query });
    },
  } as unknown as Database;
  return { database, statements };
}

/** The route over `database`, its provider answering 200 after `before`; each recover kept. */
function route(database: Database, before: (email: string) => Promise<void> = async () => {}) {
  const recovered: string[] = [];
  const custody = {
    dispatch: async (_ref: string, request: { readonly body: string }) => {
      recovered.push(request.body);
      await before((JSON.parse(request.body) as { email: string }).email);
      return {
        kind: 'answered',
        started: true,
        outbound: { ok: true, status: 200, body: '{}' },
        credentialKind: 'api_key',
        account: null,
      };
    },
  } as unknown as Custody;
  const app = new Hono();
  mountPasswordReset(app, database, enrolmentBroker(custody));
  /** One ask for `address` from the client address `peer`: its status and body, as one line. */
  const ask = async (address: string, peer: string): Promise<string> => {
    const response = await app.fetch(
      new Request(`http://api.test${PASSWORD_RESET_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ address }),
      }),
      { incoming: { socket: { remoteAddress: peer } } },
    );
    return `${String(response.status)} ${await response.text()}`;
  };
  return { ask, recovered };
}

const recovers = (recovered: readonly string[], address: string): number =>
  recovered.filter((body) => body === JSON.stringify({ email: address })).length;

describe('C40 password reset, the ask: in flight', () => {
  it('C40 reset asks in flight: a flood from many sources holds at most RESET_IN_FLIGHT asks on the database, each answered alike', async () => {
    let open = 0;
    let most = 0;
    // A database whose every transaction blocks, as one held connection does.
    const blocking = {
      withBusiness: async () => {
        open += 1;
        most = Math.max(most, open);
        return await new Promise<never>(() => {});
      },
    } as unknown as Database;
    const { ask } = route(blocking);
    const answers = await Promise.all(
      Array.from(
        { length: 10_000 },
        async (_, n) =>
          await ask(`flood-${String(n)}@example.test`, `2001:db8:${n.toString(16)}::1`),
      ),
    );
    await wait(20);
    expect(new Set(answers)).toEqual(new Set(['200 {}']));
    expect(most).toBe(RESET_IN_FLIGHT);
  });
});

describe('C40 password reset, the ask: one source', () => {
  it('C40 reset per-source gate: a flood from one client address leaves another source served', async () => {
    const { ask, recovered } = route(underLimits(20).database);
    const flood = Array.from(
      { length: 2000 },
      async (_, n) => await ask(`junk-${String(n)}@example.test`, '203.0.113.1'),
    );
    await wait(5);
    expect(await ask('victim@example.test', '198.51.100.7')).toBe('200 {}');
    await Promise.all(flood);
    await wait(100);
    expect(recovers(recovered, 'victim@example.test')).toBe(1);
  });

  it('C40 reset per-source gate: past RESET_SOURCE_LIMIT a source is dropped before the database', async () => {
    const { database, statements } = underLimits();
    const { ask, recovered } = route(database);
    for (let n = 0; n < RESET_SOURCE_LIMIT; n += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one ask at a time, each ended
      await ask(`one-${String(n)}@example.test`, '203.0.113.2');
      // oxlint-disable-next-line no-await-in-loop
      await wait(20);
    }
    expect(recovered).toHaveLength(RESET_SOURCE_LIMIT);
    const touched = statements.length;
    expect(await ask('one-more@example.test', '203.0.113.2')).toBe('200 {}');
    await wait(20);
    expect([statements.length, recovered.length]).toEqual([touched, RESET_SOURCE_LIMIT]);
    // Another source is served.
    await ask('other@example.test', '203.0.113.3');
    await wait(20);
    expect(recovers(recovered, 'other@example.test')).toBe(1);
  });
});

describe('C40 password reset, the ask: the slot and the provider', () => {
  /** How often A's ask reaches the provider, after X, B, C and D, all but X known. */
  async function reached(xKnown: boolean): Promise<number> {
    const known = new Set(
      ['b', 'c', 'd', ...(xKnown ? ['x'] : [])].map((name) => `${name}@example.test`),
    );
    // The provider mails a known address before it answers, hundreds of milliseconds.
    const { ask, recovered } = route(underLimits().database, async (email) => {
      if (known.has(email)) await wait(300);
    });
    await Promise.all(
      ['x', 'b', 'c', 'd'].map(
        async (name, n) => await ask(`${name}@example.test`, `203.0.113.${String(20 + n)}`),
      ),
    );
    await wait(20);
    await ask('a@example.test', '198.51.100.30');
    await wait(20);
    return recovers(recovered, 'a@example.test');
  }

  it('C40 reset asks in flight: the slot is held for the database work, not the provider ask', async () => {
    expect([await reached(true), await reached(false)]).toEqual([1, 1]);
  });
});
