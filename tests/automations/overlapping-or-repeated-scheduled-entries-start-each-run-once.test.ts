// SPDX-License-Identifier: AGPL-3.0-only
//
// The scheduled sweep entry (`apps/automations/sweep.ts`) run twice at once,
// as a slow round and the next minute's invocation would be, each with its
// own connections, then again for the same minute. The claim's uniqueness and
// dispatch's recheck under the activation's lock start the due run once.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sweepEntry } from '../../apps/automations/sweep.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { waitingOn } from './firing.ts';
import { prepareRuns } from './run-start.ts';
import { entrySettings, oneMinuteActivation } from './scheduled-entry.ts';
import { holdActivation, runsOf } from './sweep-race.ts';
import { createAutomationWorld, type AutomationWorld } from './world.ts';

const serverUrl = databaseUrlFromEnvironment();
const AT = (): Date => new Date(Date.UTC(2026, 10, 5, 9, 30));
const LATER_THAT_MINUTE = (): Date => new Date(Date.UTC(2026, 10, 5, 9, 30, 40));
const SWEPT = '{"firing":"on","swept":1,"noWorker":0,"failed":0}';

describe.skipIf(serverUrl === undefined)('scheduled entries at once or repeated', () => {
  let w: AutomationWorld;

  beforeAll(async () => {
    w = await createAutomationWorld('schedentryrace');
    await prepareRuns(w);
  });

  afterAll(async () => {
    await w?.db.drop();
  });

  it('two entries at once, then a third for the same minute, start the due run once', async () => {
    const activationId = await oneMinuteActivation(w);
    const settings = entrySettings(w, 'alpha');
    // Both wait on the activation's lock, so their claims truly overlap.
    const held = await holdActivation(w, activationId);
    let together: Promise<{ code: number; line: string }>[] = [];
    try {
      together = [sweepEntry(settings, { now: AT }), sweepEntry(settings, { now: AT })];
      await waitingOn(w, 2);
    } finally {
      await held.letGo();
    }
    const answers = await Promise.all(together);
    const again = await sweepEntry(settings, { now: LATER_THAT_MINUTE });
    expect([...answers, again]).toEqual([
      { code: 0, line: SWEPT },
      { code: 0, line: SWEPT },
      { code: 0, line: SWEPT },
    ]);
    expect(await w.occurrences(activationId)).toBe(1);
    expect(await runsOf(w, activationId)).toBe(1);
  });
});
