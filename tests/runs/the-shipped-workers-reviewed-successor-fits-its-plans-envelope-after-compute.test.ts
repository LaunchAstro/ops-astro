// SPDX-License-Identifier: AGPL-3.0-only
//
// Sol's proof for S2092-1 on #2092 (copied unchanged but for its names): the
// shipped worker's agent spends from the plan's envelope as it computes, and the
// reviewed successor it hands back still fits that envelope, so the person's
// launch is accepted and applied (#1717 R8b).

import { afterEach, expect, it, vi } from 'vitest';
import type { Transport } from '../../apps/cli/client.ts';
import { main } from '../../apps/worker/main.ts';
import { catalogueOf } from '../../apps/api/broker-catalogue.ts';
import { SIGN_IN_SETTINGS, signedInReach } from '../support/stand-in-gotrue.ts';
import { approve, rows } from '../runtime/schedules-harness.ts';
import { unproposed, type Sent } from './compute-seam-world.ts';
import { agentBroker } from './agent-draft-world.ts';
import { noDatabase, s, useStopWorld } from './run-stop-world.ts';

useStopWorld('r8bsuccessor');
afterEach(() => vi.restoreAllMocks());

/** What the watching transport saw: faults, the budget at the hand-back, a launch refused. */
interface Seen {
  readonly faults: unknown[];
  launchRefusal?: string;
  budget?: unknown;
}

/**
 * The worker's transport over the door, which accepts the plan once proposed,
 * reads the budget at the hand-back and tries to accept the reviewed
 * successor (its launch), then refuses every call after a refused launch.
 */
function launching(inner: Transport, log: readonly Sent[], taskId: string, seen: Seen): Transport {
  return async (...args) => {
    if (seen.launchRefusal !== undefined || log.length > 100)
      return Response.json(
        { refused: true, code: 'DELEGATION_NOT_LIVE', names: [], fixes: [] },
        { status: 409 },
      );
    let response: Response;
    try {
      response = await inner(...args);
    } catch (error) {
      seen.faults.push({
        name: (error as Error).name,
        stack: (error as Error).stack?.split('\n').slice(1, 4),
      });
      throw error;
    }
    const sent = log.at(-1);
    if (sent?.verb === 'task.propose' && response.ok) {
      const [gate] = await rows<{ version_id: string }>(
        s,
        'select version_id from public.gates where id = $1',
        [sent.detail['gateId']],
      );
      await approve(s, { gateId: sent.detail['gateId'], versionId: gate?.version_id });
    }
    if (sent?.verb === 'task.handback' && response.ok) {
      seen.budget = await rows(
        s,
        `select e.maximum_minor::text, e.held_minor::text, e.actual_minor::text,
        v.maximum_minor::text as successor_maximum_minor from public.task_envelopes e
        join public.proposal_versions v on v.business_id = e.business_id and v.id = $2
        where e.business_id = $1 and e.task_id = $3`,
        [s.business, sent.detail['successorVersionId'], taskId],
      );
      try {
        await approve(s, {
          gateId: sent.detail['successorGateId'],
          versionId: sent.detail['successorVersionId'],
        });
      } catch (error) {
        seen.launchRefusal = (error as Error).message;
      }
    }
    return response;
  };
}

/** Everything written to stdout and stderr from now until the mocks are restored. */
function printed(): string[] {
  const out: string[] = [];
  const keep = (chunk: string | Uint8Array): boolean => {
    out.push(String(chunk));
    return true;
  };
  vi.spyOn(process.stdout, 'write').mockImplementation(keep);
  vi.spyOn(process.stderr, 'write').mockImplementation(keep);
  return out;
}

it.skipIf(noDatabase)(
  'the reviewed successor stays affordable after the shipped worker computes',
  async () => {
    const broker = { ...agentBroker(), ...catalogueOf('api', false) };
    const { taskId, log, options } = await unproposed('shipped success', undefined, broker);
    const seen: Seen = { faults: [] };
    const transport = launching(options.transport, log, taskId, seen);
    const out = printed();
    const code = await main(
      [],
      {
        ...SIGN_IN_SETTINGS,
        OPS_ASTRO_BUSINESS: options.businessKey,
        OPS_ASTRO_DELEGATION: options.delegation,
        OPS_ASTRO_WORKER_INTERVAL_MS: '0',
      },
      async () => await Promise.resolve('sent'),
      {
        ...signedInReach(String(options.credential)),
        transport: () => transport,
      },
    );
    expect(
      seen.launchRefusal,
      `the shipped worker must leave a reviewed successor that fits its own envelope: ${JSON.stringify(seen.budget)}`,
    ).toBeUndefined();
    expect(
      code,
      JSON.stringify({
        out,
        faults: seen.faults,
        log: log.map(({ verb, status }) => ({ verb, status })),
      }),
    ).toBe(0);
    const turns = log.filter((sent) => sent.verb === 'model.call');
    if (turns.length > 0)
      expect(turns[0]).toMatchObject({
        status: 200,
        body: { operation: 'model.replay_turn', kind: 'turn' },
        detail: { state: 'settled', actualMinor: 100 },
      });
    const verbs = log.map((sent) => sent.verb);
    expect(verbs.indexOf('task.comment')).toBeGreaterThan(verbs.indexOf('task.handback'));
    expect(out.join('')).toContain(taskId);
  },
  120_000,
);
