// SPDX-License-Identifier: AGPL-3.0-only
//
// T4b1's invariant, `journey_twice_same_facts` (split section 3.2): the whole
// propose, decide, apply, settle journey driven through the app's own client
// and again through the command line, one process per call, against a served
// API process, leaves identical decision, receipt, reservation and event
// facts. A comparison with a pass missing, or with a pass that recorded
// nothing, is a failure, never agreement.
//
// Separation (T4a's two businesses): bravo's person is refused the task each
// pass made, on the same surface, and no answer either pass was given carries
// bravo's canary task.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createWorld, serverUrl, type World } from '../acceptance/world.ts';
import { serveApi, type ServedApi } from '../cli/cli-process-harness.ts';
import { compareFacts, type JourneyFacts } from './facts.ts';
import { personOn, runPass, type PassContext, type PassResult } from './passes.ts';

const FACTS: JourneyFacts = {
  decisions: [{ decision: 'approve' }],
  receipt: { decision: { id: '<id 1>' } },
  reservations: [{ state: 'settled' }],
  attempts: [],
  events: [{ kind: 'picked_up' }],
  audit: [],
  alerts: [],
};

describe('journey_twice_same_facts: the comparison itself', () => {
  it('refuses a comparison with either pass missing or empty', () => {
    expect(compareFacts(FACTS)).toStrictEqual({
      ok: false,
      failures: ['one-sided: the cli pass did not run'],
    });
    expect(compareFacts(undefined, FACTS).ok).toBe(false);
    const idle = compareFacts(FACTS, { ...FACTS, decisions: [], events: [] });
    expect(idle.failures).toStrictEqual([
      'one-sided: the cli pass recorded no decisions',
      'one-sided: the cli pass recorded no events',
    ]);
  });

  it('names the fact that differs', () => {
    const other = { ...FACTS, reservations: [{ state: 'released' }] };
    const compared = compareFacts(FACTS, other);
    expect(compared.ok).toBe(false);
    expect(compared.failures).toHaveLength(1);
    expect(compared.failures[0]).toMatch(/^reservations differ/u);
    expect(compareFacts(FACTS, structuredClone(FACTS))).toStrictEqual({ ok: true, failures: [] });
  });
});

// eslint-disable-next-line max-lines-per-function -- one world and two passes, built in one place
describe.skipIf(serverUrl === undefined)('journey_twice_same_facts: app and CLI', () => {
  let world: World;
  let served: ServedApi;
  let context: PassContext;
  let canary: { id: string; title: string };
  const passes: Record<'app' | 'cli', PassResult | undefined> = { app: undefined, cli: undefined };
  const broken: string[] = [];

  beforeAll(async () => {
    world = await createWorld('t4b1');
    served = await serveApi(world);
    context = { world, api: served.origin, app: served.origin, title: `Journey ${randomUUID()}` };
    const title = `Bravo canary ${randomUUID()}`;
    const made = await personOn(
      'app',
      context,
      world.bea.token,
      'bravo',
    )('task.create', {
      operationId: randomUUID(),
      fields: { title },
    });
    canary = { id: String(made.body['recordId']), title };
    expect(made.outcome, made.text).toBe('ok');
    // A pass that throws is kept as absent, so the comparison below refuses it
    // as one-sided and says why, rather than the whole suite erroring first.
    for (const surface of ['app', 'cli'] as const) {
      try {
        // eslint-disable-next-line no-await-in-loop -- the passes run in order
        passes[surface] = await runPass(surface, context);
      } catch (error) {
        broken.push(`${surface}: ${String(error).slice(0, 300)}`);
      }
    }
  }, 180_000);

  afterAll(async () => {
    await served?.stop();
    await world?.close();
  });

  it('the app pass and the CLI pass leave the same facts', () => {
    const compared = compareFacts(passes.app?.facts, passes.cli?.facts);
    expect([...compared.failures, ...broken]).toStrictEqual([]);
    expect(compared.ok).toBe(true);
    expect(passes.app?.taskId).not.toBe(passes.cli?.taskId);
  });

  it('bravo is refused each pass task on the same surface, and no answer carries its canary', async () => {
    for (const surface of ['app', 'cli'] as const) {
      const pass = passes[surface];
      expect(pass, `the ${surface} pass did not run`).toBeDefined();
      if (pass === undefined) continue;
      // eslint-disable-next-line no-await-in-loop -- one surface at a time
      const foreign = await personOn(
        surface,
        context,
        world.bea.token,
        'bravo',
      )('task.read', {
        recordId: pass.taskId,
      });
      expect(foreign.outcome, foreign.text).toBe('refused');
      expect(foreign.text).not.toContain(pass.taskId);
      expect(foreign.text).not.toContain(context.title);
      for (const answer of pass.answers) {
        expect(answer).not.toContain(canary.id);
        expect(answer).not.toContain(canary.title);
      }
    }
  });
});
