// SPDX-License-Identifier: AGPL-3.0-only
//
// An access ending's provider steps are both GoTrue's ban. When GoTrue
// answers that the user no longer exists (404, `user_not_found`), the user can
// never sign in again, so the ban's purpose holds and the step is done, never
// owed again. Only that exact answer counts: a 404 that does not name the user
// gone is doubt and stays a fault, and so does every transient failure (5xx,
// 429, a time-out). No database: the provider is a fake fetch.

import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createGoTrueLogins } from '../../apps/api/auth/logins.ts';

const subject = randomUUID();
const base = 'http://127.0.0.1:9/auth/v1';
/** GoTrue's own answer for an admin call on a user it does not hold. */
const USER_GONE = { code: 404, error_code: 'user_not_found', msg: 'User not found' };

function loginsAnswering(answer: () => Response | Promise<Response>) {
  const sent: string[] = [];
  const logins = createGoTrueLogins({
    baseUrl: base,
    adminKey: () => Promise.resolve('admin-key'),
    timeoutMs: 200,
    fetch: (input) => {
      sent.push(String(input));
      return Promise.resolve(answer());
    },
  });
  return { logins, sent };
}

async function doubtfulStaysOwed() {
  const doubtful: readonly (() => Response)[] = [
    () => new Response(null, { status: 404 }),
    () => new Response('<html>not found</html>', { status: 404 }),
    () => Response.json({ code: 404, msg: 'User not found' }, { status: 404 }),
    () => Response.json({ error_code: 'mfa_factor_not_found' }, { status: 404 }),
    () => Response.json({ error_code: 'USER_NOT_FOUND' }, { status: 404 }),
    () => Response.json({ error_code: ['user_not_found'] }, { status: 404 }),
    () => Response.json({ error: { error_code: 'user_not_found' } }, { status: 404 }),
    () => Response.json([USER_GONE], { status: 404 }),
    // The words alone, at any status but 404, are not the user gone.
    () => Response.json(USER_GONE, { status: 400 }),
    () => Response.json(USER_GONE, { status: 410 }),
    () => Response.json(USER_GONE, { status: 200 }),
  ];
  for (const [index, answer] of doubtful.entries()) {
    const { logins } = loginsAnswering(answer);
    // oxlint-disable-next-line no-await-in-loop
    const both = [await logins.endSessions(subject), await logins.deactivate(subject)];
    expect(
      both.every((each) => !each.ok),
      `doubtful answer ${String(index)}`,
    ).toBe(true);
  }
}

describe('a provider user already gone counts as banned', () => {
  it("GoTrue's 404 naming the user gone answers both ban steps done", async () => {
    const { logins, sent } = loginsAnswering(() => Response.json(USER_GONE, { status: 404 }));
    expect(await logins.endSessions(subject)).toEqual({ ok: true, value: undefined });
    expect(await logins.deactivate(subject)).toEqual({ ok: true, value: undefined });
    expect(sent).toEqual([`${base}/admin/users/${subject}`, `${base}/admin/users/${subject}`]);
  });

  it('a 404 that does not name the user gone is doubt, and the step stays owed', doubtfulStaysOwed);

  it('a transient failure (5xx, 429, a time-out) stays a fault, whatever its body says', async () => {
    const transient: readonly (readonly [() => Response | Promise<Response>, string])[] = [
      [() => Response.json(USER_GONE, { status: 500 }), 'unreachable'],
      [() => Response.json(USER_GONE, { status: 502 }), 'unreachable'],
      [() => Response.json(USER_GONE, { status: 503 }), 'unreachable'],
      [() => Response.json(USER_GONE, { status: 429 }), 'refused'],
      [
        async () =>
          await new Promise<Response>((resolve) => {
            setTimeout(() => resolve(Response.json(USER_GONE, { status: 404 })), 400);
          }),
        'slow',
      ],
    ];
    for (const [answer, fault] of transient) {
      const { logins } = loginsAnswering(answer);
      // oxlint-disable-next-line no-await-in-loop
      expect(await logins.endSessions(subject), fault).toEqual({ ok: false, fault });
      // oxlint-disable-next-line no-await-in-loop
      expect(await logins.deactivate(subject), fault).toEqual({ ok: false, fault });
    }
  });
});
