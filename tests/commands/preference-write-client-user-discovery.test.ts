// SPDX-License-Identifier: AGPL-3.0-only
//
// Discovery reads the same `EXTERNAL_WRITES` list as the R4 gate: a client user
// with no membership is shown their two own-row preference writes
// (`preference:write`, ORCH50's ruling) and no other self write or business write.

import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { buildCatalogue, reachableBy } from '../../packages/core-wire/src/catalogue.ts';

it('preference:write for a client user: discovery lists the two own-row writes and no other self write', () => {
  const available = reachableBy(buildCatalogue([]), {
    kind: 'person',
    grants: [{ key: 'task:read', scope: { kind: 'record', id: randomUUID() } }],
    member: false,
  }).map((row) => row.command);
  expect(available).toContain('preference.save');
  expect(available).toContain('preference.dismiss_tip');
  expect(available).not.toContain('notifications.set_channel');
  expect(available).not.toContain('task.update');
});
