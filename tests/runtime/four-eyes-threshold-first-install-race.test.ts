// SPDX-License-Identifier: AGPL-3.0-only
//
// Catalogue #463, seen again: the four-eyes band read `for share` locks
// nothing when the business has no `four_eyes_threshold` row, so a first
// settings install could commit under a money decision that has already read
// the shipped band. The settings install lock closes it: the reader holds it
// shared and the install waits for the reader's transaction to end.

import { expect, it } from 'vitest';
import { installBusinessSettings } from '../../packages/core-records/src/records/business-settings.ts';
import { fourEyesBandMinor } from '../../packages/core-runtime/src/four-eyes.ts';
import { useAw06World, w } from './aw-06-world.ts';
import { barrier, racer, rows } from './schedules-harness.ts';

useAw06World('four_eyes_first_install');

const thresholdRows = async (): Promise<readonly unknown[]> =>
  await rows(
    w.s,
    `select id from public.business_settings
      where business_id = $1 and key = 'four_eyes_threshold'`,
    [w.s.business],
  );

it('a first settings install waits for a four-eyes band read that found no row', async () => {
  const owner = w.s;
  expect(await thresholdRows()).toEqual([]);
  const read = barrier();
  const endReader = barrier();
  const reader = owner.db.app.withBusiness(owner.business, async (tx) => {
    const band = await fourEyesBandMinor(tx, 'AUD');
    read.release();
    await endReader.held;
    return band;
  });
  await read.held;
  const rival = racer(owner);
  let installed = false;
  const install = rival.withBusiness(owner.business, installBusinessSettings).then(() => {
    installed = true;
    return true;
  });
  try {
    await Promise.race([
      install,
      new Promise((resolve) => {
        setTimeout(resolve, 2000);
      }),
    ]);
    // The reader is still open on the shipped band: the install has not committed.
    expect(installed).toBe(false);
    endReader.release();
    expect(await reader).toBe(50_000n);
    await install;
    expect(await thresholdRows()).toHaveLength(1);
  } finally {
    endReader.release();
    await reader;
    await install;
    await rival.close();
  }
});
