// SPDX-License-Identifier: AGPL-3.0-only
//
// C40, the ask's limits: per address (the reset mail the address got in the
// hour, 0225) and per source (the asks one client address made in the hour,
// 0226), both counted in the database before the login provider is asked to
// mint a token, so a refused ask never voids the last mailed link. The
// provider's recover is a custody stand-in that counts each dispatch, over
// C39-T's hook world.

import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { mountPasswordReset, PASSWORD_RESET_PATH } from '../../apps/api/password-set.ts';
import {
  requestPasswordReset,
  RESET_SOURCE_LIMIT,
} from '../../packages/core-commands/src/index.ts';
import type { Broker } from '../../packages/core-custody/src/index.ts';
import { noDatabase, useInvitationWorld, w } from './c39-t-world.ts';
import { digest, freshSource, loginIn, mailedOut, recoverCounted } from './c40-reset-world.ts';

useInvitationWorld({ auth: true });

const C40 = describe.skipIf(noDatabase);

const addressNo = (n: number): string =>
  `src-${String(n)}-${randomUUID().slice(0, 8)}@example.test`;

/** Use up a source's asks for the hour, each for a fresh address. */
async function useUp(broker: Broker, source: string): Promise<void> {
  for (let n = 0; n < RESET_SOURCE_LIMIT; n += 1) {
    // oxlint-disable-next-line no-await-in-loop -- one ask at a time, each counted
    await requestPasswordReset(w.db.app, broker, { address: addressNo(n), source });
  }
}

/** One ask through the route, from `source`: its status, headers and body, as one line. */
async function askFrom(app: Hono, address: string, source: string): Promise<string> {
  const response = await app.fetch(
    new Request(`http://api.test${PASSWORD_RESET_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ address }),
    }),
    { incoming: { socket: { remoteAddress: source } } },
  );
  const headers = JSON.stringify([...response.headers]);
  return `${String(response.status)} ${headers} ${await response.text()}`;
}

C40('C40 password reset, the ask: per source', () => {
  it('C40 reset per-source limit: past the limit one source is refused, another served', async () => {
    const { broker, recovered } = recoverCounted();
    const [one, two] = [freshSource(), freshSource()];
    await useUp(broker, one);
    expect(recovered).toHaveLength(RESET_SOURCE_LIMIT);
    // The next ask from the same source, for a fresh address, never reaches the provider.
    await requestPasswordReset(w.db.app, broker, { address: addressNo(99), source: one });
    expect(recovered).toHaveLength(RESET_SOURCE_LIMIT);
    // A second source is served.
    await requestPasswordReset(w.db.app, broker, { address: addressNo(100), source: two });
    expect(recovered).toHaveLength(RESET_SOURCE_LIMIT + 1);
    // The source is kept as a digest only, and no address with it.
    const kept = await w.db.admin.execute<{ row: string }>(
      'select to_jsonb(a)::text as row from ops.password_reset_asks a',
    );
    const stored = kept.map((row) => row.row).join('\n');
    expect(stored).toContain(digest(one));
    expect(stored).not.toContain(one);
    expect(stored).not.toContain('@example.test');
  });
});

C40('C40 password reset, the ask: per address', () => {
  it('C40 reset limit before provider: an address at its mail limit is not asked again', async () => {
    const login = await mailedOut();
    const { broker, recovered } = recoverCounted();
    // Asked as a person types it: case and spaces do not make it a new address.
    const typed = ` ${login.address.toUpperCase()} `;
    await requestPasswordReset(w.db.app, broker, { address: typed, source: freshSource() });
    expect(recovered).toEqual([]);
    // Another login's address, under its limit, is asked.
    const other = await loginIn([w.alpha]);
    await requestPasswordReset(w.db.app, broker, { address: other.address, source: freshSource() });
    expect(recovered).toEqual([`/auth/v1/recover ${JSON.stringify({ email: other.address })}`]);
  });
});

C40('C40 password reset, the ask: no oracle when limited', () => {
  it('C40 no account oracle: limited or not, known or not, every ask is answered alike', async () => {
    const login = await mailedOut();
    const { broker } = recoverCounted();
    const app = new Hono();
    mountPasswordReset(app, w.db.app, broker);
    const busy = freshSource();
    await useUp(broker, busy);
    const [under, underToo] = [await loginIn([w.alpha]), await loginIn([w.alpha])];
    const asks: readonly (readonly [string, string])[] = [
      // Known: the address limited, then both limited.
      [login.address, freshSource()],
      [login.address, busy],
      // Known: under every limit, then the source limited.
      [under.address, freshSource()],
      [underToo.address, busy],
      // Unknown: under every limit, then the source limited.
      [`nobody-${randomUUID().slice(0, 8)}@example.test`, freshSource()],
      [`nobody-${randomUUID().slice(0, 8)}@example.test`, busy],
    ];
    const answers = new Set<string>();
    for (const [address, source] of asks) {
      // oxlint-disable-next-line no-await-in-loop -- one ask at a time
      answers.add(await askFrom(app, address, source));
    }
    expect(answers.size).toBe(1);
    expect([...answers][0]).toMatch(/^200 .* \{\}$/u);
  });
});
