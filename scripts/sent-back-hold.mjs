// SPDX-License-Identifier: AGPL-3.0-only
//
// CI-SPEED: a pull request sent back for fixes runs no checks until its fix
// head. Adding the `sent-back` label starts a ci.yml run on the same head;
// the pull request's concurrency group cancels the run still in flight or
// queued, and this step, the gate's first check, fails the new one, so every
// job that waits on the gate is skipped and takes no runner. The gate's red
// keeps the pull request out of the merge queue.
//
// Only that one event holds. The fix push (`synchronize`) runs every check in
// full whatever labels the pull request carries; removing the label runs
// them again on the head as it stands. A merge group or a push carries no
// label event, so neither is ever held. Anything this cannot read runs the
// checks in full: a mistake here costs runner time, never a check.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const LABEL = 'sent-back';

/** True when this run is the one the `sent-back` label started on a pull request. */
export function held(eventName, payload) {
  return (
    eventName === 'pull_request' && payload?.action === 'labeled' && payload?.label?.name === LABEL
  );
}

function main() {
  const eventName = process.env.GITHUB_EVENT_NAME ?? '';
  let payload;
  try {
    payload = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH ?? '', 'utf8'));
  } catch {
    console.log('sent-back hold: no event to read; every check runs');
    return 0;
  }
  if (!held(eventName, payload)) {
    console.log('sent-back hold: not held; every check runs');
    return 0;
  }
  console.error(
    `sent-back hold: this pull request was sent back for fixes (label '${LABEL}'). ` +
      'No check runs on this head. The fix push runs every check; removing the label runs them now.',
  );
  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exit(main());
}
