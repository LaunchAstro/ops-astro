// SPDX-License-Identifier: AGPL-3.0-only
//
// Sign-out's server half (C23, C58), run after the tab has already forgotten
// the session. `session.end` must land before the sign-out route ends the
// session, or it is refused as an ended session and the sign-out is never
// recorded. So it is waited for, but briefly, and its errors are ignored.

import { signOutOf } from './session/sign-in.ts';

/** How long sign-out waits for `session.end` before ending the session anyway. */
export const SESSION_END_WAIT_MS = 2000;

export async function endThenSignOut(
  record: () => Promise<unknown>,
  route: Parameters<typeof signOutOf>[0],
  ended: Parameters<typeof signOutOf>[1],
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const waited = new Promise<void>((done) => {
    timer = setTimeout(done, SESSION_END_WAIT_MS);
  });
  // Answered, refused or failed: either way the sign-out goes on.
  const recorded = record().catch((error: unknown) => error);
  await Promise.race([recorded, waited]);
  clearTimeout(timer);
  await signOutOf(route, ended);
}
