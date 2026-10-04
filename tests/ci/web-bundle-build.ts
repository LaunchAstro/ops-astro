// SPDX-License-Identifier: AGPL-3.0-only
//
// Whether a test that reads the built web bundle must build it first.
//
// `pnpm check` builds apps/web/dist before its tests, and several tests copy
// that bundle while others run beside them. A test that rebuilt it regardless
// would empty it under them (scripts/build.mjs clears the directory first), so
// a bundle already stamped with this clean commit (apps/web/build-stamp.ts) is
// kept. Anything else is rebuilt: no bundle, a bundle with no stamp or another
// commit's, and any bundle of a changed tree, whose `-dirty` stamp cannot say
// which change it was built from.

import { readStamp } from '../../apps/web/build-stamp.ts';

/** True when `dist` must be rebuilt before a test reads it as the tree `identifier` names. */
export function needsBuild(dist: string, identifier: string): boolean {
  return identifier.endsWith('-dirty') || readStamp(dist) !== identifier;
}
