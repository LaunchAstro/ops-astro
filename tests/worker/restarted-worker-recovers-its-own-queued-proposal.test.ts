// SPDX-License-Identifier: AGPL-3.0-only
//
// A worker that restarts, or a second copy of it on the same delegation,
// knows nothing of the proposal it or its twin already made. It looks in the
// queue first: its own proposal, approved and waiting, is the work its next
// pass applies, and nothing is proposed again. While its earlier proposal
// still waits for a person, the server refuses a second one
// (`TRANSITION_NOT_PERMITTED`), and the worker reads that as nothing to do
// yet rather than a failure. The API is a stub here: only the answers matter.

import { describe, expect, it } from 'vitest';
import type { Transport } from '../../apps/cli/client.ts';
import { createWorker, SYNTHETIC_STEP } from '../../apps/worker/worker.ts';
import { SYNTHETIC_USAGE } from '../../apps/worker/usage.ts';

const TASK = '0199a000-0000-7000-8000-000000000001';
const AGENT = '0199a000-0000-7000-8000-000000000002';

const ok = (detail: object): Response => new Response(JSON.stringify({ detail }), { status: 200 });

const refused = (code: string): Response =>
  new Response(JSON.stringify({ refused: true, code, names: [] }), { status: 409 });

/** A stub API: each verb's answer, and every verb asked, in order. */
function stub(queue: readonly object[], propose: () => Response) {
  const asked: string[] = [];
  const answer = (verb: string): Response => {
    asked.push(verb);
    if (verb === 'session.capabilities') {
      const capabilities = { agentActorId: AGENT, purposeScope: { id: TASK } };
      return new Response(JSON.stringify(capabilities), { status: 200 });
    }
    if (verb === 'task.read') return ok({ task: { revision: 1, proposals: [] } });
    if (verb === 'task.queue') return ok({ queue });
    if (verb === 'task.propose') return propose();
    return refused('NOT_FOUND');
  };
  const transport: Transport = async (path) =>
    await Promise.resolve(answer(path.split('/').slice(-2).join('.')));
  return { asked, transport };
}

const workerOn = (transport: Transport) =>
  createWorker({
    transport,
    businessKey: 'acme',
    credential: 'agent-login',
    delegation: '0199a000-0000-7000-8000-000000000003',
    reporter: SYNTHETIC_USAGE,
  } as never);

describe('a restarted worker and its earlier proposal', () => {
  it('finds its own approved proposal in the queue and proposes nothing again', async () => {
    const api = stub(
      [
        {
          taskId: TASK,
          proposedByActorId: AGENT,
          purpose: SYNTHETIC_STEP.kind,
          reservationId: '0199a000-0000-7000-8000-000000000004',
        },
      ],
      () => ok({ version: 2, gateId: 'second-gate' }),
    );
    expect(await workerOn(api.transport).proposeOnce()).toStrictEqual({
      queued: { taskId: TASK },
    });
    expect(api.asked).not.toContain('task.propose');
  });

  it('reads a refused second proposal, while the first still waits for a person, as nothing to do yet', async () => {
    const api = stub([], () => refused('TRANSITION_NOT_PERMITTED'));
    expect(await workerOn(api.transport).proposeOnce()).toStrictEqual({ idle: { taskId: TASK } });
  });
});
