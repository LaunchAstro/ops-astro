// SPDX-License-Identifier: AGPL-3.0-only
//
// Settings ▸ Workflow triggers' made-up registry (C33) for the width-and-theme
// harness: one automation on a schedule pinned to its second version under a
// standing approval (C52-A), and one skill run by hand with none. Test side
// only, like the rest of `made-up-*.ts`.

import type { AutomationRegistryResult } from '../../packages/core-wire/src/index.ts';
import { NATHAN } from './made-up-access.ts';

const version = (
  id: string,
  number: number,
  modes: readonly ('manual' | 'scheduled')[],
): AutomationRegistryResult['definitions'][number]['versions'][number] => ({
  id,
  number,
  contentDigest: 'a'.repeat(64),
  contentSize: 2048,
  modes,
  releasedBy: NATHAN.personId,
  releasedAt: `2026-09-2${String(number)}T01:00:00.000Z`,
});

export const AUTOMATION_REGISTRY: AutomationRegistryResult = {
  ok: true,
  definitions: [
    {
      id: 'd-weekly',
      kind: 'automation',
      name: 'Weekly client report',
      versions: [
        version('v-weekly-1', 1, ['manual', 'scheduled']),
        version('v-weekly-2', 2, ['manual', 'scheduled']),
      ],
      activations: [
        {
          id: 'a-weekly',
          versionId: 'v-weekly-2',
          versionNumber: 2,
          mode: 'scheduled',
          everyMinutes: 10_080,
          eventKind: null,
          enabled: true,
          changedBy: NATHAN.personId,
          changedAt: '2026-09-24T02:00:00.000Z',
          revision: 2,
          approval: {
            id: 'ap-weekly-2',
            versionId: 'v-weekly-2',
            act: 'adopted',
            decidedBy: NATHAN.personId,
            revoked: false,
          },
        },
      ],
    },
    {
      id: 'd-brief',
      kind: 'skill',
      name: 'Draft the campaign brief',
      versions: [version('v-brief-1', 1, ['manual'])],
      activations: [
        {
          id: 'a-brief',
          versionId: 'v-brief-1',
          versionNumber: 1,
          mode: 'manual',
          everyMinutes: null,
          eventKind: null,
          enabled: true,
          changedBy: NATHAN.personId,
          changedAt: '2026-09-21T03:00:00.000Z',
          revision: 1,
          approval: null,
        },
      ],
    },
  ],
};
