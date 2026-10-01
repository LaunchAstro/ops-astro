// SPDX-License-Identifier: AGPL-3.0-only
//
// The made-up answers for Settings Keys (C31) and Workflow triggers (C33,
// C52-A), beside made-up-api.ts, which serves them. Test side only; every name
// is made up, and no answer carries a secret's value.

import type {
  AutomationRegistryResult,
  SecretListResult,
} from '../../packages/core-wire/src/index.ts';

const PERSON = 'p-nathan';

/** Settings Keys (C31): names, scopes and states only; a value is never in any answer. */
export const SECRETS: SecretListResult = {
  ok: true,
  secrets: [
    {
      id: 's-1',
      name: 'xero.api_key',
      clientId: null,
      state: 'set',
      setAt: '2026-09-12T01:00:00.000Z',
      lastUsedAt: '2026-09-25T21:40:00.000Z',
      revision: 2,
    },
    {
      id: 's-2',
      name: 'google_ads.refresh_token',
      clientId: 'c-meridian',
      state: 'set',
      setAt: '2026-09-18T03:00:00.000Z',
      lastUsedAt: null,
      revision: 1,
    },
    {
      id: 's-3',
      name: 'meta.page_token',
      clientId: 'c-meridian',
      state: 'not set',
      setAt: null,
      lastUsedAt: null,
      revision: 3,
    },
  ],
};

const VERSION = {
  contentDigest: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
  contentSize: 1024,
  releasedBy: PERSON,
} as const;

/** Settings Workflow triggers (C33, C52-A): one scheduled and approved, one on an event. */
export const REGISTRY: AutomationRegistryResult = {
  ok: true,
  definitions: [
    {
      id: 'd-1',
      kind: 'automation',
      name: 'Weekly client report',
      versions: [
        {
          ...VERSION,
          id: 'v-1',
          number: 1,
          modes: ['manual', 'scheduled'],
          releasedAt: '2026-09-10T00:00:00.000Z',
        },
        {
          ...VERSION,
          id: 'v-2',
          number: 2,
          modes: ['manual', 'scheduled'],
          releasedAt: '2026-09-22T00:00:00.000Z',
        },
      ],
      activations: [
        {
          id: 'a-1',
          versionId: 'v-2',
          versionNumber: 2,
          mode: 'scheduled',
          everyMinutes: 10080,
          eventKind: null,
          enabled: true,
          changedBy: PERSON,
          changedAt: '2026-09-22T01:00:00.000Z',
          revision: 3,
          approval: {
            id: 'ap-1',
            versionId: 'v-2',
            act: 'adopted',
            decidedBy: PERSON,
            revoked: false,
          },
        },
      ],
    },
    {
      id: 'd-2',
      kind: 'skill',
      name: 'Review reply drafts',
      versions: [
        {
          ...VERSION,
          id: 'v-3',
          number: 1,
          modes: ['manual', 'event'],
          releasedAt: '2026-09-15T00:00:00.000Z',
        },
      ],
      activations: [
        {
          id: 'a-2',
          versionId: 'v-3',
          versionNumber: 1,
          mode: 'event',
          everyMinutes: null,
          eventKind: 'review.received',
          enabled: true,
          changedBy: PERSON,
          changedAt: '2026-09-16T01:00:00.000Z',
          revision: 1,
          approval: null,
        },
      ],
    },
  ],
};
