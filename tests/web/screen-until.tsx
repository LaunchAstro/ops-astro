// SPDX-License-Identifier: AGPL-3.0-only
//
// The wait a mounted screen's tests share. It reaches no database, so a
// screen test on made-up answers imports it without becoming database-bound
// (tests/db/named-suite-manifest.test.ts).

import { act } from 'react';
import type { Mounted } from '../surfaces/mount.tsx';

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
