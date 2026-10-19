// SPDX-License-Identifier: AGPL-3.0-only
//
// #1624 R7 (#1716), no database: the agent's catalogue is its task, read,
// and `live_correction.request` with exactly a person's operands, #1693's
// `{taskId, page, word, replacement}` with no base revision. The
// broker keeps nothing else, a correction's result comes back as its row by
// id, and the agent's runner computes a draft through the worker's one call
// port with no connection of its own (egress denied throughout).

import { describe, expect, it } from 'vitest';
import { agentRunner } from '../../apps/worker/agent-runner.ts';
import type { Answered, Call } from '../../apps/worker/agent-call.ts';
import { readTurn, toolsKept } from '../../packages/core-custody/src/broker-turn-read.ts';
import { denyEgress } from '../harness/deny-egress.ts';

const TASK = '00000000-0000-4000-8000-0000000000a1';
const CORRECTION = '00000000-0000-4000-8000-0000000000c7';

/** A person's request on the business's own about page, as the agent asks it (#1693's shape). */
const REQUEST = {
  taskId: TASK,
  page: 'https://own.example/about',
  word: 'Townsvile',
  replacement: 'Townsville',
};

const asks = (name: string, args: Readonly<Record<string, unknown>>, id = 'call_1') => ({
  ref: 'answer',
  callId: 'answer_1',
  text: 'Asking.',
  toolCalls: [{ id, name, args }],
});

const turnOf = (tools: readonly string[], parts: readonly unknown[]) =>
  readTurn({ turnOrdinal: 1, tools, parts } as never);

const kept = (tools: readonly string[], parts: readonly unknown[]): boolean | undefined => {
  const turn = turnOf(tools, parts);
  return turn === undefined ? undefined : toolsKept(turn);
};

const TOOLS = ['task.read', 'live_correction.request'];
const TASK_PART = { ref: 'task', taskId: TASK, revision: 3 };
const RESULT = { ref: 'correction', correctionId: CORRECTION, toolCallId: 'call_1' };

describe("the broker's catalogue for an agent", () => {
  it("keeps a correction asked with exactly a person's operands, its result the row by id", () => {
    expect(kept(TOOLS, [TASK_PART, asks('live_correction.request', REQUEST), RESULT])).toBe(true);
  });

  it('refuses a correction asked with an operand a person cannot send', () => {
    const wider = { ...REQUEST, state: 'approved' };
    expect(kept(TOOLS, [TASK_PART, asks('live_correction.request', wider)])).toBe(false);
    const { replacement: _dropped, ...narrower } = REQUEST;
    expect(kept(TOOLS, [TASK_PART, asks('live_correction.request', narrower)])).toBe(false);
  });

  it('refuses a correction that types its own base revision or party, which the M5 pins', () => {
    for (const typed of [{ baseRevision: 'b'.repeat(40) }, { partyId: null }, { path: 'x.md' }]) {
      const asked = asks('live_correction.request', { ...REQUEST, ...typed });
      expect(kept(TOOLS, [TASK_PART, asked])).toBe(false);
    }
  });

  it('offers no tool that reaches outside the app', () => {
    expect(kept([...TOOLS, 'site.source.read'], [TASK_PART])).toBe(false);
    expect(kept(TOOLS, [TASK_PART, asks('site.source.read', { path: 'x' })])).toBe(false);
  });

  it("refuses a result that answers another tool's call", () => {
    const read = asks('task.read', { taskId: TASK });
    expect(kept(TOOLS, [TASK_PART, read, RESULT])).toBe(false);
    const request = asks('live_correction.request', REQUEST);
    expect(kept(TOOLS, [TASK_PART, request, { ...TASK_PART, toolCallId: 'call_1' }])).toBe(false);
  });

  it('refuses a correction result out of its shape', () => {
    const request = asks('live_correction.request', REQUEST);
    expect(turnOf(TOOLS, [TASK_PART, request, { ...RESULT, state: 'requested' }])).toBeUndefined();
  });
});

interface Sent {
  readonly verb: string;
  readonly body: Readonly<Record<string, unknown>>;
}

const ok = (detail: Record<string, unknown>, body: Record<string, unknown> = {}): Answered => ({
  body: { ...body, detail },
  detail,
});

/** The door as the runner meets it: a task read, three scripted turns, and the request it stores. */
function scriptedDoor(): { readonly call: Call; readonly sent: Sent[] } {
  const sent: Sent[] = [];
  const answers = [
    {
      text: 'Reading the task.',
      toolCalls: [{ id: 'call_1', name: 'task.read', args: { taskId: TASK } }],
    },
    {
      text: 'Asking.',
      toolCalls: [{ id: 'call_2', name: 'live_correction.request', args: REQUEST }],
    },
    { text: 'Drafted for your decision.', toolCalls: [] },
  ];
  const call: Call = async (verb, body) => {
    sent.push({ verb, body: body as Sent['body'] });
    if (verb === 'task.read') return await Promise.resolve(ok({}, { task: { revision: 3 } }));
    if (verb === 'live_correction.request') {
      return await Promise.resolve(ok({ correctionId: CORRECTION, state: 'locating' }));
    }
    const turn = sent.filter((each) => each.verb === 'model.call').length;
    return await Promise.resolve(ok({ callId: `answer_${String(turn)}`, ...answers[turn - 1] }));
  };
  return { call, sent };
}

describe("the agent's runner", () => {
  it('drafts one correction through the call port, with no connection of its own', async () => {
    const door = scriptedDoor();
    const guard = denyEgress();
    let end;
    try {
      end = await agentRunner({ operation: 'model.replay_turn' }).compute({
        phase: 'compute',
        taskId: TASK,
        attemptId: 'attempt',
        lease: { leaseId: 'lease', fence: 1 },
        call: door.call,
      });
    } finally {
      guard.release();
    }
    expect(guard.attempts).toEqual([]);
    expect(end).toEqual({ outcome: 'success', endCode: 'COMPLETED' });
    expect(door.sent.map((each) => each.verb)).toEqual([
      'task.read',
      'model.call',
      'task.read',
      'model.call',
      'live_correction.request',
      'model.call',
    ]);
    const requests = door.sent.filter((each) => each.verb === 'live_correction.request');
    expect(requests.map((each) => each.body)).toEqual([REQUEST]);
    const last = door.sent.at(-1)?.body as { parts?: readonly unknown[] } | undefined;
    expect(last?.parts?.at(-2)).toMatchObject({ ref: 'answer', callId: 'answer_2' });
    expect(last?.parts?.at(-1)).toEqual({ ...RESULT, toolCallId: 'call_2' });
  });
});
