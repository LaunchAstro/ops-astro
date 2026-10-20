// SPDX-License-Identifier: AGPL-3.0-only
//
// Sol's proof for S2092-2 on #2092 (copied unchanged but for its names, two type annotations, and its turn script
// and `main()` call moved out of the test body for the line limit; #1717 R8b).
// Five ordinary task-read tool results followed by a final answer need six
// model calls, below the shipped limit of twelve. Observe the real graph's
// thrown error without changing its input, config or execution. The shipped
// main must hand back, accept the reviewed successor and apply its comment.

import { afterEach, expect, it, vi } from 'vitest';
import type { Transport } from '../../apps/cli/client.ts';
import { main } from '../../apps/worker/main.ts';
import { catalogueOf } from '../../apps/api/broker-catalogue.ts';
import { SIGN_IN_SETTINGS, signedInReach } from '../support/stand-in-gotrue.ts';
import { approve, rows } from '../runtime/schedules-harness.ts';
import { unproposed, type Sent } from './compute-seam-world.ts';
import { agentBroker, replied } from './agent-draft-world.ts';
import { noDatabase, s, useStopWorld, world } from './run-stop-world.ts';

const { graphErrors } = vi.hoisted(() => ({ graphErrors: [] as string[] }));
vi.mock('langchain', async (original) => {
  const actual = await original<typeof import('langchain')>();
  return {
    ...actual,
    createAgent: (...args: Parameters<typeof actual.createAgent>) => {
      const graph = actual.createAgent(...args);
      return {
        invoke: async (...inputs: Parameters<typeof graph.invoke>) => {
          try {
            return await graph.invoke(...inputs);
          } catch (error) {
            graphErrors.push(`${(error as Error).name}: ${(error as Error).message}`);
            throw error;
          }
        },
      };
    },
  };
});
useStopWorld('r8bsixturns');
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

/** The provider's turns: a task read each, then a final answer on the last. */
function scriptTurns(count: number, taskId: string): void {
  world.provider.script(
    Array.from({ length: count }, (_, i) => ({
      ...(replied(
        'Proof turn',
        i + 1 === count ? [] : [{ id: `read_${i}`, name: 'task.read', args: { taskId } }],
      ) as object),
      usage: { input: count === 1 ? 100 : 500, output: 0 },
    })),
  );
}

/** The shipped worker's `main()`, signed in as the plan's delegation over `transport`. */
async function shippedMain(
  options: Awaited<ReturnType<typeof unproposed>>['options'],
  transport: Transport,
): Promise<number> {
  return await main(
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
}

it.skipIf(noDatabase)(
  'the shipped worker completes a six-turn accepted plan below its call limit',
  async () => {
    const count: number = 6;
    const broker = { ...agentBroker(), ...catalogueOf('api', false) };
    const { taskId, log, options } = await unproposed('shipped success', undefined, broker);
    scriptTurns(count, taskId);
    const seen: Seen = { faults: [] };
    const transport = launching(options.transport, log, taskId, seen);
    const out = printed();
    const code = await shippedMain(options, transport);
    expect(
      seen.launchRefusal,
      `the shipped worker must leave a reviewed successor that fits its own envelope: ${JSON.stringify(seen.budget)}`,
    ).toBeUndefined();
    expect(graphErrors, 'six valid model turns must fit below the twelve-call limit').toEqual([]);
    expect(
      code,
      JSON.stringify({
        out: out.slice(0, 3),
        graphErrors,
        faults: seen.faults,
        log: log
          .filter(({ verb }) => verb !== 'task.queue')
          .map(({ verb, status }) => ({ verb, status })),
      }),
    ).toBe(0);
    const turns = log.filter((sent) => sent.verb === 'model.call');
    if (turns.length > 0) expect(turns).toHaveLength(count);
    if (turns.length > 0)
      expect(turns[0]).toMatchObject({
        status: 200,
        body: { operation: 'model.agent_turn', kind: 'turn' },
        detail: { state: 'settled', actualMinor: count === 1 ? 100 : 500 },
      });
    const verbs = log.map((sent) => sent.verb);
    expect(verbs.indexOf('task.comment')).toBeGreaterThan(verbs.indexOf('task.handback'));
    expect(out.join('')).toContain(taskId);
  },
  120_000,
);
