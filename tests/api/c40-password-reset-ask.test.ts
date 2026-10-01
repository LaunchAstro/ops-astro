// SPDX-License-Identifier: AGPL-3.0-only
//
// C40, the ask: `POST /api/password/reset` hands an address to the login
// provider through custody (`auth.recover`, the service key in custody) and
// answers every request alike, at once. Custody here is a stand-in that
// records each dispatch and answers as a case sets it, hostile answers among
// them; the real custody's route list is pinned in
// `c39-t-server-enrolment.test.ts`. And `main()`'s switch for the hook and
// the reset routes: off without the secret, refused without what it needs.

import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { authHookReady } from '../../apps/api/auth-email-hook.ts';
import { enrolmentBroker } from '../../apps/api/enrolment-broker.ts';
import { mountPasswordReset, PASSWORD_RESET_PATH } from '../../apps/api/password-set.ts';
import type { Custody, CustodyOutcome } from '../../packages/core-custody/src/index.ts';

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

/** A custody stand-in: every dispatch recorded, answered by `answer`. */
function standIn(answer: () => Promise<CustodyOutcome>) {
  const dispatched: Dispatched[] = [];
  const custody = {
    dispatch: async (ref: string, request: Dispatched['request']) => {
      dispatched.push({ ref, request });
      return await answer();
    },
  } as unknown as Custody;
  const app = new Hono();
  mountPasswordReset(app, enrolmentBroker(custody));
  return { app, dispatched };
}

async function ask(app: Hono, body: string): Promise<{ status: number; text: string }> {
  const response = await app.fetch(
    new Request(`http://api.test${PASSWORD_RESET_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    }),
  );
  return { status: response.status, text: await response.text() };
}

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
