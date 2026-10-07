// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createGoTrueLogins } from '../../apps/api/auth/logins.ts';

const subject = randomUUID();
const base = 'http://127.0.0.1:9/auth/v1';
const bannedUser = { id: subject, banned_until: '2999-01-01T00:00:00Z' };
const metadata = { notes: 'a'.repeat(32 * 1024) };

describe.each(['endSessions', 'deactivate'] as const)(
  '%s through GoTrue PUT /auth/v1/admin/users/{subject}',
  (step) => {
    it('accepts a valid admin user response larger than 16 KiB', async () => {
      const body = JSON.stringify({
        id: subject,
        banned_until: '2999-01-01T00:00:00Z',
        user_metadata: { notes: 'a'.repeat(32 * 1024) },
      });
      expect(Buffer.byteLength(body)).toBeGreaterThan(16 * 1024);
      const logins = createGoTrueLogins({
        baseUrl: base,
        adminKey: () => Promise.resolve('test-only-admin-key'),
        fetch: (input, init) => {
          expect(String(input)).toBe(`${base}/admin/users/${subject}`);
          expect(init?.method).toBe('PUT');
          expect(init?.redirect).toBe('error');
          expect(JSON.parse(String(init?.body))).toEqual({ ban_duration: '876000h' });
          const headers = new Headers(init?.headers);
          expect(headers.get('authorization')).toBe('Bearer test-only-admin-key');
          expect(headers.get('apikey')).toBe('test-only-admin-key');
          return Promise.resolve(new Response(body));
        },
      });
      expect(await logins[step](subject)).toEqual({ ok: true, value: undefined });
    });
  },
);

describe.each(['endSessions', 'deactivate'] as const)(
  '%s through GoTrue PUT /auth/v1/admin/users/{subject}',
  (step) => {
    it.each(['normal', 'exactly 1 MiB'])(
      'accepts a valid admin user response of %s size',
      async (size) => {
        const empty = JSON.stringify({ ...bannedUser, user_metadata: { notes: '' } });
        const body =
          size === 'normal'
            ? JSON.stringify(bannedUser)
            : JSON.stringify({
                ...bannedUser,
                user_metadata: { notes: 'a'.repeat(1024 * 1024 - Buffer.byteLength(empty)) },
              });
        if (size !== 'normal') expect(Buffer.byteLength(body)).toBe(1024 * 1024);
        const logins = createGoTrueLogins({
          baseUrl: base,
          adminKey: () => Promise.resolve('test-only-admin-key'),
          fetch: () => Promise.resolve(new Response(body)),
        });
        expect(await logins[step](subject)).toEqual({ ok: true, value: undefined });
      },
    );
  },
);

describe.each(['endSessions', 'deactivate'] as const)(
  '%s through GoTrue PUT /auth/v1/admin/users/{subject}',
  (step) => {
    it.each([
      ['invalid JSON', `${JSON.stringify({ ...bannedUser, user_metadata: metadata })}!`],
      ['wrong user', JSON.stringify({ ...bannedUser, id: randomUUID(), user_metadata: metadata })],
      [
        'missing id',
        JSON.stringify({ banned_until: bannedUser.banned_until, user_metadata: metadata }),
      ],
      ['no ban', JSON.stringify({ ...bannedUser, banned_until: null, user_metadata: metadata })],
      [
        'expired ban',
        JSON.stringify({
          ...bannedUser,
          banned_until: '2001-01-01T00:00:00Z',
          user_metadata: metadata,
        }),
      ],
      ['array', JSON.stringify([{ ...bannedUser, user_metadata: metadata }])],
    ])('refuses a large %s response as malformed', async (_name, body) => {
      expect(Buffer.byteLength(body)).toBeGreaterThan(16 * 1024);
      const logins = createGoTrueLogins({
        baseUrl: base,
        adminKey: () => Promise.resolve('test-only-admin-key'),
        fetch: () => Promise.resolve(new Response(body)),
      });
      expect(await logins[step](subject)).toEqual({ ok: false, fault: 'malformed' });
    });
  },
);

describe.each(['endSessions', 'deactivate'] as const)(
  '%s through GoTrue PUT /auth/v1/admin/users/{subject}',
  (step) => {
    it('refuses and cancels a valid user response exceeding 1 MiB despite a small content-length', async () => {
      const empty = JSON.stringify({ ...bannedUser, user_metadata: { notes: '' } });
      const body = Buffer.from(
        JSON.stringify({
          ...bannedUser,
          user_metadata: { notes: 'a'.repeat(1024 * 1024 + 1 - Buffer.byteLength(empty)) },
        }),
      );
      expect(body.byteLength).toBe(1024 * 1024 + 1);
      let cancelled = false;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(body.subarray(0, 512 * 1024));
          controller.enqueue(body.subarray(512 * 1024));
        },
        cancel() {
          cancelled = true;
        },
      });
      const logins = createGoTrueLogins({
        baseUrl: base,
        adminKey: () => Promise.resolve('test-only-admin-key'),
        fetch: () => Promise.resolve(new Response(stream, { headers: { 'content-length': '16' } })),
      });
      expect(await logins[step](subject)).toEqual({ ok: false, fault: 'oversized' });
      expect(cancelled).toBe(true);
    });
  },
);

describe.each(['endSessions', 'deactivate'] as const)(
  '%s through GoTrue PUT /auth/v1/admin/users/{subject}',
  (step) => {
    it('keeps an explicitly configured response limit', async () => {
      const logins = createGoTrueLogins({
        baseUrl: base,
        adminKey: () => Promise.resolve('test-only-admin-key'),
        maxBytes: 16 * 1024,
        fetch: () => Promise.resolve(Response.json({ ...bannedUser, user_metadata: metadata })),
      });
      expect(await logins[step](subject)).toEqual({ ok: false, fault: 'oversized' });
    });

    it('keeps the provider refusal even when its body names the right banned user', async () => {
      const logins = createGoTrueLogins({
        baseUrl: base,
        adminKey: () => Promise.resolve('test-only-admin-key'),
        fetch: () => Promise.resolve(Response.json(bannedUser, { status: 401 })),
      });
      expect(await logins[step](subject)).toEqual({ ok: false, fault: 'refused' });
    });
  },
);

it('keeps DELETE /auth/v1/admin/users/{subject}/factors/{factorId} bounded at 16 KiB', async () => {
  const factorId = randomUUID();
  const logins = createGoTrueLogins({
    baseUrl: base,
    adminKey: () => Promise.resolve('test-only-admin-key'),
    fetch: (input, init) => {
      expect(String(input)).toBe(`${base}/admin/users/${subject}/factors/${factorId}`);
      expect(init?.method).toBe('DELETE');
      return Promise.resolve(Response.json({ id: factorId, user_metadata: metadata }));
    },
  });
  expect(await logins.deleteFactor?.(subject, factorId)).toEqual({ ok: false, fault: 'oversized' });
});
