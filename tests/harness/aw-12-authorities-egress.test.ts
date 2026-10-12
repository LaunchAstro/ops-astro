// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-12 authorities, A6 (provider independence, TEST.md 2 and 4.5): the
// framework stand-in runs its own loop over the four fakes with every egress
// denied, and needs none. A tool the framework registers that reaches for the
// network (a vendor's telemetry, a call home) is refused at the network layer
// and recorded, so the catalogue is not the only barrier. No database.

import dns from 'node:dns';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { denyEgress, type EgressGuard } from './deny-egress.ts';
import { fakeClock, sourceCorpus } from './fake-clock-corpus.ts';
import { fakeEffect } from './fake-effect.ts';
import { fakeModel, type ModelReply } from './fake-model.ts';
import { standIn } from './framework-stand-in.ts';

let guard: EgressGuard;
beforeEach(() => {
  guard = denyEgress();
});
afterEach(() => {
  guard.release();
});

/** A port nothing listens on, on loopback: even an unguarded attempt never leaves the host. */
const CALL_HOME = 'http://127.0.0.1:9/collect';

/** The stand-in on the four fakes, with one tool that writes and two that reach for the network. */
function onTheFakes() {
  const clock = fakeClock();
  const lines = sourceCorpus()
    .slice(0, 3)
    .map((doc) => ({
      input: `Summarise ${doc.id}.`,
      text: `Summary of ${doc.id}.`,
      outputUnits: 12,
    }));
  const model = fakeModel(lines, clock);
  const effect = fakeEffect();
  const framework = standIn({
    settings: {},
    model: async (input) => await model.client.complete({ model: 'replay-1', input }),
    tools: new Map<string, (input: string) => Promise<unknown>>([
      [
        'site.write',
        async (body) =>
          await Promise.resolve(effect.service.write({ mode: 'neither', key: null, body })),
      ],
      ['telemetry', async () => await fetch(CALL_HOME, { method: 'POST', body: '{}' })],
      ['resolve', async (host) => await dns.promises.lookup(host)],
    ]),
    retries: 0,
    read: (reply) =>
      (reply as ModelReply).kind === 'answer' ? { ok: true } : { ok: false, why: 'failed' },
  });
  return { clock, lines, model, effect, framework };
}

describe('AW-12 authorities: a framework holds none of the eight authorities', () => {
  it('A6 provider independence: all egress is denied to the four fakes', async () => {
    const { clock, lines, model, effect, framework } = onTheFakes();
    // The whole loop on the fakes: plan, read the corpus a window at a time, write, wait.
    framework.plan(
      'run-1',
      lines.map((line) => line.input),
    );
    for (const line of lines) {
      // oxlint-disable-next-line no-await-in-loop -- one step at a time, as a loop runs
      const { last } = await framework.step(line.input);
      expect(last).toMatchObject({ kind: 'answer', text: line.text });
    }
    expect(await framework.callTool('site.write', 'The corrected copy.')).toMatchObject({
      kind: 'accepted',
    });
    clock.advance(60_000);
    expect(effect.fixture.history.at(-1)?.body).toBe('The corrected copy.');
    expect(model.fixture.seen).toHaveLength(lines.length);
    expect(guard.attempts).toStrictEqual([]);

    // A tool that calls home, and one that resolves a vendor's host: refused and recorded.
    await expect(framework.callTool('telemetry', '')).rejects.toThrow(/egress denied/u);
    await expect(framework.callTool('resolve', 'telemetry.vendor.invalid')).rejects.toThrow(
      /egress denied/u,
    );
    expect(guard.attempts).toStrictEqual([`fetch ${CALL_HOME}`, 'dns telemetry.vendor.invalid']);
  });
});
