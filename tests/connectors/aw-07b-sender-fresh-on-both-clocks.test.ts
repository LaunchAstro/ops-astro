// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-07b sender: a sender report stands for `SENDER_FRESH_MS` from its answer
// on both host clocks. The monotonic clock does not count a suspended host, so
// a process paused past the window resumes with a report that looks a moment
// old there; the wall clock counted the pause, and the report is stale. A wall
// clock stepped back does not make an old report fresh either: either clock
// past the window ends it, as the send fence does (`lapsed`).

import { afterEach, expect, it, vi } from 'vitest';
import {
  checkSender,
  fakeSenderSource,
  SENDER_FRESH_MS,
  senderFresh,
} from '../../packages/core-connectors/src/index.ts';

const MONOTONIC_START = 5_000;
const WALL_START = Date.parse('2026-10-14T03:00:00.000Z');

/** Both host clocks, set by each case: the report is stamped at the start, then judged. */
const clocks = { monotonic: MONOTONIC_START, wall: WALL_START };

afterEach(() => {
  vi.restoreAllMocks();
});

async function reportAtStart() {
  clocks.monotonic = MONOTONIC_START;
  clocks.wall = WALL_START;
  vi.spyOn(performance, 'now').mockImplementation(() => clocks.monotonic);
  vi.spyOn(Date, 'now').mockImplementation(() => clocks.wall);
  const source = {
    ...fakeSenderSource({
      name: 'send.example.test',
      dkim: 'verified',
      spf: 'verified',
      returnPathMx: 'verified',
      dmarc: ['v=DMARC1; p=reject'],
    }),
    mock: false,
  };
  const report = await checkSender(source, 'send.example.test', 'example.test');
  expect(report.verified).toBe(true);
  return report;
}

it('AW-07b sender: a report judged after the host slept past the window is stale, though the monotonic clock barely moved', async () => {
  const report = await reportAtStart();
  clocks.monotonic += 1_000;
  clocks.wall += SENDER_FRESH_MS + 1_000;
  expect(senderFresh(report)).toBe(false);
});

it('AW-07b sender: a report past the window on the monotonic clock stays stale when the wall clock steps back', async () => {
  const report = await reportAtStart();
  clocks.monotonic += SENDER_FRESH_MS + 1_000;
  clocks.wall -= 3_600_000;
  expect(senderFresh(report)).toBe(false);
});

it('AW-07b sender: a report inside the window on both clocks is fresh, up to the window itself', async () => {
  const report = await reportAtStart();
  clocks.monotonic += 1_000;
  clocks.wall += 1_000;
  expect(senderFresh(report)).toBe(true);
  clocks.monotonic = MONOTONIC_START + SENDER_FRESH_MS;
  clocks.wall = WALL_START + SENDER_FRESH_MS;
  expect(senderFresh(report)).toBe(true);
});
