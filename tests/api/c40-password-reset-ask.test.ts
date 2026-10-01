// SPDX-License-Identifier: AGPL-3.0-only
//
// C40, the ask: `POST /api/password/reset` hands an address to the login
// provider through custody (`auth.recover`, the service key in custody) and
// answers every request alike, at once. Custody here is a stand-in that
// records each dispatch and answers as a case sets it, hostile answers among
// them; the real custody's route list is pinned in
// `c39-t-server-enrolment.test.ts`. The database is a stand-in too, under
// every limit, recording the source each ask is counted under; the limits
// themselves are counted in a real database in `c40-reset-ask-limits.test.ts`.
// A blocking database holds a flood of asks to the in-flight cap. And
// `main()`'s switch for the hook and the reset routes: off without the
// secret, refused without what it needs.

import { createHash } from 'node:crypto';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { authHookReady } from '../../apps/api/auth-email-hook.ts';
import { enrolmentBroker } from '../../apps/api/enrolment-broker.ts';
import {
  mountPasswordReset,
  PASSWORD_RESET_PATH,
  RESET_IN_FLIGHT,
} from '../../apps/api/password-set.ts';
import type { Custody, CustodyOutcome } from '../../packages/core-custody/src/index.ts';
import type { Database } from '../../packages/core-records/src/index.ts';

const CANARY = 'CANARY-c40-ask-5e2a91';

interface Dispatched {
  readonly ref: string;
  readonly request: { readonly path: string; readonly method?: string; readonly body: string };
}

const answered = (status: number, body: string): CustodyOutcome => ({
  kind: 'answered',
  started: true,
  outbound: { ok: true, status, body },
  credentialKind: 'api_key',
  account: null,
});

/** A database under every limit: each statement's parameters recorded, every count 0. */
function underLimits(statements: (readonly unknown[])[]): Database {
  return {
    withBusiness: async (_business: string, run: (tx: unknown) => Promise<unknown>) =>
      await run({
        query: async (_text: string, parameters: readonly unknown[] = []) => {
          statements.push(parameters);
          return await Promise.resolve([{ source: 0, address: 0 }]);
        },
      }),
  } as unknown as Database;
}

/** A custody stand-in: every dispatch recorded, answered by `answer`. */
function standIn(answer: () => Promise<CustodyOutcome>) {
  const dispatched: Dispatched[] = [];
  const statements: (readonly unknown[])[] = [];
  const custody = {
    dispatch: async (ref: string, request: Dispatched['request']) => {
      dispatched.push({ ref, request });
      return await answer();
    },
  } as unknown as Custody;
  const app = new Hono();
  mountPasswordReset(app, underLimits(statements), enrolmentBroker(custody));
  return { app, dispatched, statements };
}

/** The request's client address, the way `@hono/node-server` hands the socket over. */
const fromPeer = (remoteAddress: string) => ({ incoming: { socket: { remoteAddress } } });

async function ask(
  app: Hono,
  body: string,
  env?: object,
): Promise<{ status: number; text: string }> {
  const response = await app.fetch(
    new Request(`http://api.test${PASSWORD_RESET_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    }),
    env,
  );
  return { status: response.status, text: await response.text() };
}

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

const settle = async (): Promise<void> => {
  await new Promise((resolve) => {
    setTimeout(resolve, 20);
  });
};

const BODIES = [
  JSON.stringify({ address: 'known@example.test' }),
  JSON.stringify({ address: 'Unknown@Example.test ' }),
  JSON.stringify({ address: `not an address ${CANARY}` }),
  JSON.stringify({ address: 42 }),
  JSON.stringify({}),
  'not json',
];

describe('C40 password reset, the ask', () => {
  it('C40 no account oracle: every ask is answered alike, before the provider answers', async () => {
    // The provider never answers: the person is answered anyway, and the same.
    const { app, dispatched } = standIn(async () => await new Promise<CustodyOutcome>(() => {}));
    const answers = [];
    for (const body of BODIES) {
      // oxlint-disable-next-line no-await-in-loop -- one ask at a time
      answers.push(await ask(app, body));
    }
    expect(new Set(answers.map((one) => `${String(one.status)} ${one.text}`))).toEqual(
      new Set(['200 {}']),
    );
    await settle();
    // Only well-formed addresses reach the provider, lower-cased, through the `auth` route.
    expect(dispatched.map((one) => [one.ref, one.request.path, one.request.body])).toEqual([
      ['auth_key', '/auth/v1/recover', JSON.stringify({ email: 'known@example.test' })],
      ['auth_key', '/auth/v1/recover', JSON.stringify({ email: 'unknown@example.test' })],
    ]);
  });

  it('C40 hostile provider: a wrong or failed recover answer changes nothing the person sees', async () => {
    const hostile: readonly (() => Promise<CustodyOutcome>)[] = [
      async () => await Promise.resolve(answered(200, `[${JSON.stringify(CANARY)}]`)),
      async () => await Promise.resolve(answered(200, `not json ${CANARY}`)),
      async () =>
        await Promise.resolve({
          kind: 'answered',
          started: true,
          outbound: { ok: false, fault: 'status', status: 500 },
          credentialKind: 'api_key',
          account: null,
        } as CustodyOutcome),
      async () => await Promise.resolve({ kind: 'refused', started: false, code: CANARY }),
      async () => await Promise.resolve({ kind: 'worker_lost', started: true, fault: 'ours' }),
      async () => await Promise.reject(new Error(CANARY)),
    ];
    for (const answer of hostile) {
      const { app, dispatched } = standIn(answer);
      // oxlint-disable-next-line no-await-in-loop -- one provider at a time
      const reply = await ask(app, BODIES[0] ?? '');
      expect(reply).toEqual({ status: 200, text: '{}' });
      // oxlint-disable-next-line no-await-in-loop
      await settle();
      expect(dispatched).toHaveLength(1);
    }
  });
});

describe('C40 password reset, the ask: its source', () => {
  it('C40 reset per-source limit: an ask is counted under its client address, hashed', async () => {
    const { app, statements } = standIn(async () => await Promise.resolve(answered(200, '{}')));
    await ask(app, BODIES[0] ?? '', fromPeer('203.0.113.7'));
    await settle();
    const written = statements.flat().map(String).join(' ');
    expect(written).toContain(sha256('203.0.113.7'));
    expect(written).not.toContain('203.0.113.7');
    expect(written).not.toContain('known@example.test');
  });
});

describe('C40 password reset, the ask: its source key', () => {
  /** The source digest each ask from `peers` was counted under, one ask at a time. */
  async function keysOf(peers: readonly string[]): Promise<readonly unknown[]> {
    const { app, statements } = standIn(async () => await Promise.resolve(answered(200, '{}')));
    const keys: unknown[] = [];
    for (const peer of peers) {
      const first = statements.length;
      // oxlint-disable-next-line no-await-in-loop -- one ask at a time
      await ask(app, BODIES[0] ?? '', fromPeer(peer));
      // oxlint-disable-next-line no-await-in-loop
      await settle();
      keys.push(statements[first]?.[0]);
    }
    return keys;
  }

  it('C40 reset per-source key: an IPv6 client is counted by its /64, a mapped IPv4 as the IPv4', async () => {
    const [one, two, other, mapped] = await keysOf([
      '2001:db8:1:2:aaaa::1',
      '2001:0db8:0001:0002:ffff:ffff:ffff:fffe',
      '2001:db8:1:3::1',
      '::ffff:203.0.113.9',
    ]);
    expect(one).toBe(two);
    expect(other).not.toBe(one);
    expect(mapped).toBe(sha256('203.0.113.9'));
  });

  it('C40 reset per-source key: the peer is read before the body, so a reset mid-body keeps it', async () => {
    const { app, statements } = standIn(async () => await Promise.resolve(answered(200, '{}')));
    const env = { incoming: { socket: { remoteAddress: '203.0.113.10' as string | undefined } } };
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        // The socket goes away while the body is read, as a reset one does.
        env.incoming.socket.remoteAddress = undefined;
        controller.enqueue(new TextEncoder().encode(BODIES[0] ?? ''));
        controller.close();
      },
    });
    const request = new Request(`http://api.test${PASSWORD_RESET_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      duplex: 'half',
    } as RequestInit);
    expect((await app.fetch(request, env)).status).toBe(200);
    await settle();
    expect(statements[0]?.[0]).toBe(sha256('203.0.113.10'));
  });
});

describe('C40 password reset, the ask: in flight', () => {
  it('C40 reset asks in flight: a flood holds at most RESET_IN_FLIGHT asks on the database, and the server still answers', async () => {
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
    const custody = { dispatch: async () => await Promise.resolve(answered(200, '{}')) };
    const app = new Hono();
    app.get('/api/other', (context) => context.json({ served: true }, 200));
    mountPasswordReset(app, blocking, enrolmentBroker(custody as unknown as Custody));
    const answers = await Promise.all(
      Array.from({ length: 10_000 }, async (_, n) => {
        const reply = await ask(
          app,
          JSON.stringify({ address: `flood-${String(n)}@example.test` }),
        );
        return `${String(reply.status)} ${reply.text}`;
      }),
    );
    await settle();
    expect(new Set(answers)).toEqual(new Set(['200 {}']));
    expect(most).toBeGreaterThan(0);
    expect(most).toBeLessThanOrEqual(RESET_IN_FLIGHT);
    const other = await app.fetch(new Request('http://api.test/api/other'));
    expect(other.status).toBe(200);
  });
});

describe('C40 the hook and the reset routes in main()', () => {
  const configured = { kind: 'configured', secret: 'whsec_x' } as const;

  it('is off without the secret, whatever else is on', () => {
    expect(authHookReady({ kind: 'absent' }, true, true)).toEqual({ kind: 'absent' });
    expect(authHookReady({ kind: 'absent' }, false, false)).toEqual({ kind: 'absent' });
  });

  it('is on with the secret, enrolment and the mail, and refused without either', () => {
    expect(authHookReady(configured, true, true)).toEqual(configured);
    for (const [enrol, mail] of [
      [false, true],
      [true, false],
      [false, false],
    ] as const) {
      const ready = authHookReady(configured, enrol, mail);
      expect(ready.kind).toBe('invalid');
      expect(JSON.stringify(ready)).not.toContain('whsec_x');
    }
  });
});
