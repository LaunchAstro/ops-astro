// SPDX-License-Identifier: AGPL-3.0-only
//
// The launch decision and the write-off read a business setting under their
// locks (the client sign-off, the four-eyes band). Either may wait on a first
// settings install; a grant that ends during that wait no longer counts, so
// each holds the setting before it reads its clock.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { executeCommand } from '../../packages/core-commands/src/index.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { reviewed } from './aw-08-gate-world.ts';
import {
  approveBody,
  asPerson,
  codeOf,
  openSchedules,
  racer,
  rows,
  type Schedules,
} from './schedules-harness.ts';
import {
  grantsEndSoon,
  pastGrantsBehindInstall,
  withoutSettings,
} from './settings-install-held.ts';
import { holdOf, writeOffBody } from './t3c-harness.ts';
import { openBilling, t3d1Harness } from './t3d1-harness.ts';

const url = databaseUrlFromEnvironment();

describe.skipIf(url === undefined)('a settings install wait before the locked clock', () => {
  let s: Schedules;
  const h = t3d1Harness(() => s);

  beforeAll(async () => {
    s = await openSchedules('settings_wait_clock', 1_000_000);
    await openBilling(s);
  }, 180_000);

  afterAll(async () => {
    await s?.db.drop();
  });

  it('a launch approval refuses once the approver’s grants end during the settings install wait', async () => {
    const { proposal } = await reviewed(s, 'settings wait launch');
    await withoutSettings(s);
    const restore = await grantsEndSoon(s, s.decider.personId);
    const approver = racer(s);
    try {
      const answer = await pastGrantsBehindInstall(
        s,
        s.decider.personId,
        async () => await asPerson(s, approveBody(proposal), approver),
      );
      expect(codeOf(answer)).toBe('SCOPE_NOT_GRANTED');
    } finally {
      await approver.close();
      await restore();
    }
    expect(
      await rows(
        s,
        `select id from public.reservations where business_id = $1 and version_id = $2`,
        [s.business, proposal['versionId']],
      ),
    ).toEqual([]);
  }, 60_000);

  it('a write-off refuses once the person’s grants end during the settings install wait', async () => {
    const w = await h.unknownStep({ applied: false });
    const before = await holdOf(s, w);
    await withoutSettings(s);
    const restore = await grantsEndSoon(s, s.decider.personId);
    const writer = racer(s);
    try {
      const answer = await pastGrantsBehindInstall(
        s,
        s.decider.personId,
        async () =>
          await executeCommand(writer, s.business, s.decider.presented, 'api', {
            ...writeOffBody(w, 1_000),
            operationId: randomUUID(),
          } as never),
      );
      expect(codeOf(answer)).toBe('SCOPE_NOT_GRANTED');
    } finally {
      await writer.close();
      await restore();
    }
    expect(await holdOf(s, w)).toStrictEqual(before);
  }, 60_000);
});
