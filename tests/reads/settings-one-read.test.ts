// SPDX-License-Identifier: AGPL-3.0-only
//
// `settings.read` reads `business_settings` once (thermo review b282216, L3).
// With a second statement for the author, joined by key, read committed could
// hand back a value from one commit and its author from the next. The stub
// below answers every statement with the same row and records what was sent.

import { describe, expect, it } from 'vitest';
import { readSettings } from '../../packages/core-records/src/reads/settings.ts';
import type { TenantQuery } from '../../packages/core-records/src/tenancy/database.ts';

const ROW = {
  id: '00000000-0000-4000-8000-000000000001',
  key: 'four_eyes_threshold_minor',
  label: 'Four-eyes threshold',
  value_type: 'numeric',
  value: 50_000,
  write_mode: 'owned',
  owning_operation: ['settings.set_four_eyes_threshold'],
  visibility_class: 'business',
  updated_at: new Date('2026-09-24T00:00:00Z'),
  updated_by_actor_id: '00000000-0000-4000-8000-0000000000aa',
  revision: 3,
};

describe('settings.read', () => {
  it('reads the value and its author in one statement', async () => {
    const sent: string[] = [];
    const tx: TenantQuery = {
      businessId: '00000000-0000-4000-8000-0000000000bb',
      query: async <Row>(text: string): Promise<readonly Row[]> => {
        sent.push(text);
        return [ROW as Row];
      },
    };
    const settings = await readSettings(tx);
    expect(sent.filter((text) => text.includes('business_settings'))).toHaveLength(1);
    expect(settings).toStrictEqual([
      {
        key: 'four_eyes_threshold_minor',
        value: 50_000,
        valueType: 'numeric',
        updatedAt: '2026-09-24T00:00:00.000Z',
        updatedByActorId: '00000000-0000-4000-8000-0000000000aa',
        revision: 3,
      },
    ]);
  });
});
