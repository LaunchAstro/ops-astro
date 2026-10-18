// SPDX-License-Identifier: AGPL-3.0-only
//
// The plan's prepare before an accept (#1620 P4). An offer is ids only, so
// with the owner's ChatGPT plan set the agent cannot yet tell a plan call
// from any other: before each accept, custody makes the plan's token ready.
// A refused prepare still accepts, since a plan request is then refused at
// `present()` with nothing sent and any other call is untouched. A prepare
// past its bound accepts nothing, so the call is released, nothing sent.

import { PLAN_PREPARE_MS } from '../../packages/core-custody/src/agent.ts';

/** Whether a call may be accepted: at once with no prepare, or once it answers within PLAN_PREPARE_MS. */
export async function preparedInTime(custody: { prepare?(): Promise<unknown> }): Promise<boolean> {
  if (custody.prepare === undefined) return true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const lapsed = new Promise<false>((done) => {
    timer = setTimeout(() => done(false), PLAN_PREPARE_MS);
  });
  try {
    return await Promise.race([
      custody.prepare().then(
        () => true,
        () => true,
      ),
      lapsed,
    ]);
  } finally {
    clearTimeout(timer);
  }
}
