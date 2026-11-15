// SPDX-License-Identifier: AGPL-3.0-only
//
// Signing the cast in again (#2478). A bearer lasts an hour, as GoTrue's do,
// and a suite that runs longer (`d06-generated.test.ts` runs for hours) signs
// its people in again rather than stretching that hour.

import { decode } from 'hono/jwt';
import { tokenFor } from './cast.ts';
import type { World } from './world.ts';

/**
 * The same person signed in again, now: a new bearer for the subject `token`
 * names, with the second factor where `token` carried it, stamped as a fresh
 * sign-in. `expiresIn` is its life in seconds, an hour unless given.
 */
export async function signedInAgain(
  token: string,
  options: { readonly expiresIn?: number } = {},
): Promise<string> {
  const { payload } = decode(token);
  const subject = payload['sub'];
  if (typeof subject !== 'string') throw new Error('signedInAgain: the bearer names no subject');
  return await tokenFor(subject, { ...options, secondFactor: payload['aal'] === 'aal2' });
}

/**
 * Everyone in `world`'s cast and each of `others` signed in again, each
 * bearer replaced in place. A holder is the object later calls read their
 * bearer from (a `Caller`, a fixture client), read-only to the cases; this is
 * its one writer.
 */
export async function signInAgainAll(
  world: Pick<World, 'ada' | 'mia' | 'noah' | 'orphan' | 'bea' | 'agent'>,
  others: Iterable<{ readonly token: string }>,
  options: { readonly expiresIn?: number } = {},
): Promise<void> {
  const { ada, mia, noah, orphan, bea, agent } = world;
  for (const holder of new Set([ada, mia, noah, orphan, bea, agent, ...others])) {
    // eslint-disable-next-line no-await-in-loop -- a handful of signatures, in order
    const token = await signedInAgain(holder.token, options);
    (holder as { token: string }).token = token;
  }
}
