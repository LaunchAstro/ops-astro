// SPDX-License-Identifier: AGPL-3.0-only
//
// The server's business resolver (`createBusinessResolver` in
// `apps/api/server.ts`) answers the business that holds a key now. One warm
// resolver answers `alpha` for A; A's key then moves to `alpha-old` and B takes
// `alpha`, and the same resolver asked again answers B. It goes red if the
// resolver keeps an earlier answer for a key, which would let a person who
// belongs to both businesses read or change A through the address naming B.
// No database: a stand-in lookup connection holds the keys and counts reads.

import { describe, expect, it } from 'vitest';
import { createBusinessResolver, LOOKUP_ROLE } from '../../apps/api/server.ts';
import type { AdminConnection } from '../../packages/core-records/src/index.ts';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

/** The lookup connection over a mutable key table, refusing anything but the lookup role's read. */
function lookupOver(keys: Map<string, string>) {
  const statements: string[] = [];
  const execute = async <Row>(text: string, parameters: readonly unknown[] = []) => {
    statements.push(text);
    if (text === `set local role ${LOOKUP_ROLE}`) return await Promise.resolve([] as Row[]);
    if (!text.startsWith('select id from public.businesses where key = $1')) {
      throw new Error(`unexpected statement: ${text}`);
    }
    const id = keys.get(String(parameters[0]));
    return await Promise.resolve((id === undefined ? [] : [{ id }]) as Row[]);
  };
  const admin = {
    transaction: async <T>(run: (step: typeof execute) => Promise<T>) => await run(execute),
  } as unknown as AdminConnection;
  return { admin, statements };
}

describe('a business key moved from one business to another', () => {
  it('names the business that holds it now on the same warm resolver', async () => {
    const keys = new Map([['alpha', A]]);
    const { admin } = lookupOver(keys);
    const resolve = createBusinessResolver(admin);
    expect(await resolve('alpha')).toBe(A);

    keys.delete('alpha');
    keys.set('alpha-old', A);
    keys.set('alpha', B);

    expect(await resolve('alpha'), 'the warm resolver still names the previous holder').toBe(B);
    expect(await resolve('alpha-old')).toBe(A);
  });

  it('names nobody once the key is released, on the same warm resolver', async () => {
    const keys = new Map([['alpha', A]]);
    const { admin } = lookupOver(keys);
    const resolve = createBusinessResolver(admin);
    expect(await resolve('alpha')).toBe(A);

    keys.delete('alpha');

    expect(await resolve('alpha')).toBeUndefined();
  });

  it('reads every key as the lookup role, inside its own transaction', async () => {
    const { admin, statements } = lookupOver(new Map([['alpha', A]]));
    const resolve = createBusinessResolver(admin);
    await resolve('alpha');
    await resolve('alpha');
    expect(statements.filter((text) => text === `set local role ${LOOKUP_ROLE}`)).toHaveLength(2);
  });
});
