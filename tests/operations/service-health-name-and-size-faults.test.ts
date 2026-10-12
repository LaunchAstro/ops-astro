// SPDX-License-Identifier: AGPL-3.0-only
//
// The service-health read's shaping of a source's answer, called directly: a
// service name is shown as text on one line, so it holds no control, line
// separator or direction control, and an answer naming more services than the
// read takes is `oversized`, not `malformed`.

import { describe, expect, it } from 'vitest';
import {
  readServiceHealth,
  type ServiceObservation,
  type SourceAnswer,
} from '../../packages/core-commands/src/index.ts';

const now = new Date('2026-10-12T00:00:00Z');

const service = (name: string): ServiceObservation => ({
  name,
  scope: 'installation',
  up: true,
  observedAt: new Date(now.getTime() - 60_000),
});

const watcherSays = async (services: readonly ServiceObservation[]) => {
  const answer: SourceAnswer = { ok: true, services };
  const section = await readServiceHealth(
    { watcher: { observe: async () => await Promise.resolve(answer) } },
    now,
  );
  return section.sources[0];
};

describe('service health shaping', () => {
  it('a service name with a control, a line separator or a direction control is malformed', async () => {
    const hostile = [
      ['C1 control', 'api\u0085worker'],
      ['C1 control CSI', 'api\u009B31m'],
      ['line separator', 'api worker'],
      ['paragraph separator', 'api worker'],
      ['left-to-right mark', 'api‎'],
      ['right-to-left mark', 'api‏'],
      ['embedding', 'api‪worker'],
      ['override', 'api‮krow'],
      ['isolate', 'api⁦worker'],
      ['isolate end', 'api⁩worker'],
    ] as const;
    for (const [what, name] of hostile) {
      // oxlint-disable-next-line no-await-in-loop
      expect(await watcherSays([service(name)]), what).toEqual({
        source: 'watcher',
        state: 'read-failure',
        fault: 'malformed',
      });
    }
    // An accented name and an emoji are text a person reads.
    expect(await watcherSays([service('Zoë’s mailer 📬')])).toEqual({
      source: 'watcher',
      state: 'read',
      fault: null,
    });
  });

  it('more services than the read takes is oversized, not malformed', async () => {
    const many = Array.from({ length: 201 }, (_, index) => service(`service ${index}`));
    expect(await watcherSays(many)).toEqual({
      source: 'watcher',
      state: 'read-failure',
      fault: 'oversized',
    });
    expect(await watcherSays(many.slice(0, 200))).toEqual({
      source: 'watcher',
      state: 'read',
      fault: null,
    });
  });
});
