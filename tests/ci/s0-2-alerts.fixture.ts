// SPDX-License-Identifier: AGPL-3.0-only
//
// S0-2's alert suites' shared helpers (s0-2-alerts.test.ts and
// s0-2-security-alerts.test.ts): a fake sink and a detector on a hand clock.

import { type SinkEvent } from '../../apps/api/alerts/sink.ts';
import { createDetector } from '../../apps/api/alerts/detect.ts';

export const ROOT: string = process.cwd();

export function fakeSink(): {
  readonly events: SinkEvent[];
  readonly send: (e: SinkEvent) => Promise<void>;
} {
  const events: SinkEvent[] = [];
  return { events, send: (event) => Promise.resolve(void events.push(event)) };
}

type Detector = ReturnType<typeof createDetector>;

export function detectorFor(start = 0): {
  readonly raised: string[];
  readonly observe: Detector['observe'];
  readonly detector: Detector;
  readonly advance: (ms: number) => number;
} {
  let now = start;
  const raised: string[] = [];
  const detector = createDetector((kind) => raised.push(kind), { now: () => now });
  return { raised, observe: detector.observe, detector, advance: (ms: number) => (now += ms) };
}

export const alpha: { readonly business: 'alpha' } = { business: 'alpha' } as const;
