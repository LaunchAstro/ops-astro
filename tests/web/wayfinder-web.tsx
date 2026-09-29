// SPDX-License-Identifier: AGPL-3.0-only
//
// The wayfinder screens' world (WF-3 to WF-5): the agent CLI's world, with a
// browser client per person whose every call goes through the composed API
// and the same envelopes the routes call. A screen mounted over it reads and
// writes the real database; nothing stands in for the server.

import { act } from 'react';
import type { Hono } from 'hono';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { tokenFor } from '../api/fixture.ts';
import type { Member } from '../commands/fixture.ts';
import type { Mounted } from '../surfaces/mount.tsx';

/** A signed-in browser for `member`, on `businessKey`'s prefix. */
export async function browserFor(
  api: Hono,
  member: Member,
  businessKey: string,
): Promise<OperationsClient> {
  return new OperationsClient({
    origin: 'http://api.test',
    businessKey,
    token: await tokenFor(member.presented.subject),
    fetch: (async (url: string | URL | Request, init?: RequestInit) =>
      await api.fetch(new Request(url, init))) as typeof fetch,
  });
}

/** Let the screen's reads and writes land, until `ready` holds or the wait runs out. */
export async function until(
  mounted: Mounted,
  ready: () => boolean,
  what: string,
  timeout = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeout;
  const step = async (): Promise<void> => {
    if (ready()) return;
    if (Date.now() > deadline) {
      throw new Error(`waited for ${what}; the page says: ${mounted.text()}`);
    }
    await act(async () => {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 20);
      });
    });
    await step();
  };
  await step();
}
