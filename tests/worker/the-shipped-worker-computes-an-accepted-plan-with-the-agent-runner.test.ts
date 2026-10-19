// SPDX-License-Identifier: AGPL-3.0-only
//
// #1624 R8b (#1717, director ruling register 162): `pnpm worker` computes an
// accepted plan with the agent's runner, its turns the catalogued replay turn
// operation, never the synthetic runner that hands the plan straight back. The
// API and the sign-in service are fakes; nothing leaves the process. The plan's
// lease is refused `LAUNCH_NOT_DECIDED` at dispatch, so the worker computes;
// once the agent's first turn is asked (or a hand-back sent), every later call
// is refused for a delegation no longer live, and the worker exits after its
// tenth such pass.

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Transport } from '../../apps/cli/client.ts';
import { main } from '../../apps/worker/main.ts';
import { REPLAY_TURN } from '../../packages/core-connectors/src/index.ts';
import { pathOf, type CommandName } from '../../packages/core-wire/src/index.ts';
import { SIGN_IN_SETTINGS } from '../support/stand-in-gotrue.ts';

const SETTINGS = {
  OPS_ASTRO_BUSINESS: 'alpha',
  ...SIGN_IN_SETTINGS,
  OPS_ASTRO_DELEGATION: 'delegation-r8b',
  OPS_ASTRO_WORKER_INTERVAL_MS: '0',
};
const VERBS: readonly CommandName[] = [
  'session.capabilities',
  'task.queue',
  'task.read',
  'task.propose',
  'task.pickup',
  'task.dispatch',
  'task.handback',
  'model.call',
  'run.end',
];

interface Sent {
  readonly verb: string;
  readonly body: Record<string, unknown>;
}

const refusal = (code: string): Response =>
  Response.json({ refused: true, code, names: [], fixes: [] }, { status: 409 });

/** The fake API: a proposal, its approval in the queue, a plan lease, then refusals. */
function api(sent: Sent[]): Transport {
  return (path, body) => {
    const verb = VERBS.find((one) => path.endsWith(pathOf(one))) ?? path;
    sent.push({ verb, body: JSON.parse(body) as Record<string, unknown> });
    const proposed = sent.some((call) => call.verb === 'task.propose');
    // The plan computed or went straight to review: either way, this pass is the last.
    if (sent.some((call) => call.verb === 'model.call' || call.verb === 'task.handback')) {
      return Promise.resolve(refusal('DELEGATION_NOT_LIVE'));
    }
    const answers: Readonly<Record<string, unknown>> = {
      'session.capabilities': { agentActorId: 'agent-1', purposeScope: { id: 'task-1' } },
      'task.queue': {
        detail: {
          queue: proposed
            ? [
                {
                  taskId: 'task-1',
                  proposedByActorId: 'agent-1',
                  purpose: 'synthetic_comment',
                  reservationId: 'reservation-1',
                },
              ]
            : [],
        },
      },
      'task.read': { detail: { task: { revision: 1 } } },
      'task.propose': { detail: { version: 1, gateId: 'gate-1' } },
      'task.pickup': {
        detail: {
          leaseId: 'lease-1',
          fence: 1,
          attemptId: '00000000-0000-4000-8000-0000000000c1',
          credential: 'work-credential',
          expiresAt: new Date(Date.now() + 600_000).toISOString(),
        },
      },
      'task.handback': { detail: { successorGateId: 'gate-2', successorVersionId: 'version-2' } },
    };
    if (verb === 'task.dispatch') return Promise.resolve(refusal('LAUNCH_NOT_DECIDED'));
    return Promise.resolve(Response.json(answers[verb] ?? {}));
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the shipped worker on an accepted plan', () => {
  it("computes with the agent's runner on the replay turn operation, never straight to review", async () => {
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const sent: Sent[] = [];
    const signIn = (() =>
      Promise.resolve(
        Response.json({ access_token: 'bearer-r8b', expires_in: 3_600 }),
      )) as typeof fetch;
    const code = await main([], SETTINGS, async () => await Promise.resolve('sent'), {
      transport: () => api(sent),
      signIn,
    });

    const verbs = sent.map((call) => call.verb);
    const turn = sent.find((call) => call.verb === 'model.call');
    expect(turn?.body, verbs.join(' ')).toMatchObject({
      operation: REPLAY_TURN.key,
      kind: 'turn',
      leaseId: 'lease-1',
    });
    expect(verbs.indexOf('model.call')).toBeGreaterThan(verbs.indexOf('task.dispatch'));
    expect(verbs).not.toContain('task.handback');
    expect(code).toBe(1);
  });
});
