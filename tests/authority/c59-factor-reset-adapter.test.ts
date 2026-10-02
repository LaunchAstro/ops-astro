// SPDX-License-Identifier: AGPL-3.0-only
//
// C59 (ORCH65-Q3): GoTrue's admin removal of one factor, the call a factor
// reset owes, distrusted as C58's and C59's other provider calls are: one
// fixed destination, no redirect followed, a time and a size limit, a shape.
// Done is the factor named back; anything else is a fault by its kind alone.
// No database: the provider is a fake fetch.

import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createGoTrueLogins } from '../../apps/api/auth/logins.ts';

const CANARY = 'CANARY-c59-factor-reset-adapter-51c0e2';

const subject = randomUUID();
const factorId = randomUUID();
const base = 'http://127.0.0.1:9/auth/v1';

async function oneDeleteNamedBack(): Promise<void> {
  const sent: { url: string; init: RequestInit | undefined }[] = [];
  const logins = createGoTrueLogins({
    baseUrl: base,
    adminKey: () => Promise.resolve('admin-key'),
    fetch: (input, init) => {
      sent.push({ url: String(input), init });
      return Promise.resolve(Response.json({ id: factorId, factor_type: 'totp' }));
    },
  });
  expect(await logins.deleteFactor?.(subject, factorId)).toEqual({ ok: true, value: undefined });
  expect(sent).toHaveLength(1);
  expect(sent[0]?.url).toBe(`${base}/admin/users/${subject}/factors/${factorId}`);
  expect(sent[0]?.init?.method).toBe('DELETE');
  expect(sent[0]?.init?.redirect).toBe('error');
  expect(sent[0]?.init?.body).toBeUndefined();
  const headers = new Headers(sent[0]?.init?.headers);
  expect(headers.get('authorization')).toBe('Bearer admin-key');
  expect(headers.get('apikey')).toBe('admin-key');
}

const HOSTILE: readonly (() => Response | Promise<Response>)[] = [
  () => new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/' } }),
  () => new Response('x'.repeat(64 * 1024), { status: 200 }),
  () => new Response('not json', { status: 200 }),
  () => Response.json({ id: randomUUID() }),
  () => Response.json([{ id: factorId }]),
  () => Response.json({ message: CANARY }, { status: 500 }),
  () => Response.json({ message: CANARY }, { status: 404 }),
  async () =>
    await new Promise<Response>((resolve) => {
      setTimeout(() => resolve(Response.json({ id: factorId })), 400);
    }),
];

async function hostileNeverDone(): Promise<void> {
  for (const [index, hostile] of HOSTILE.entries()) {
    const logins = createGoTrueLogins({
      baseUrl: base,
      adminKey: () => Promise.resolve('admin-key'),
      timeoutMs: 200,
      maxBytes: 16 * 1024,
      fetch: () => Promise.resolve(hostile()),
    });
    // oxlint-disable-next-line no-await-in-loop
    const answer = await logins.deleteFactor?.(subject, factorId);
    expect(answer?.ok, `hostile answer ${String(index)}`).toBe(false);
    expect(JSON.stringify(answer)).not.toContain(CANARY);
  }
  const never = createGoTrueLogins({
    baseUrl: base,
    adminKey: () => Promise.resolve('admin-key'),
    fetch: () => Promise.reject(new Error('sent')),
  });
  const refused = { ok: false, fault: 'refused' };
  expect(await never.deleteFactor?.('../admin', factorId)).toEqual(refused);
  expect(await never.deleteFactor?.(subject, `${factorId}/..`)).toEqual(refused);
}

describe('C59 the admin removal at GoTrue', () => {
  it(
    'C59 adapter: one DELETE of the factor under the admin key, no body, no redirect, done when named back',
    oneDeleteNamedBack,
  );
  it(
    'C59 adapter: a hostile answer never counts as done, and an id out of shape is never sent',
    hostileNeverDone,
  );
});
