// SPDX-License-Identifier: AGPL-3.0-only
//
// What `run.end` does to data (#1623 R1), an entry of `COMMAND_EFFECTS`
// (data-effects.ts): the worker's stop records its attempt's outcome, releases
// its unsent holds and retires its work, the lease released and its
// delegation revoked.

import { business, client, writing, type DataEffects } from './data-effects-types.ts';

export const RUN_END_EFFECTS: DataEffects = writing([
  ...client('leases', 'model_calls', 'run_outcomes'),
  ...business('delegations'),
]);
