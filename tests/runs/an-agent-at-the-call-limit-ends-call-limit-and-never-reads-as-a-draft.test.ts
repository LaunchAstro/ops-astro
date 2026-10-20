// SPDX-License-Identifier: AGPL-3.0-only
//
// #1623 R4: the agent on the real pinned stack ends each attempt in one named
// outcome, and only a final answer with no stop is success. LangChain's own
// limits raise rather than end (their defaults, "end" and "continue", read as
// a normal finish), each set to the server's limit, and the server's
// settlement of the limit-th call is what ends the attempt `call_limit`. The
// broker is a scripted port answering as the settled turn does.
//
// Control: a task read, then a final answer, is success, with the turn's
// tool call round-tripped: the second turn carries the first answer back
// byte for byte and the tool's result as the task at the revision it read.

import { expect, it } from 'vitest';
import { runAttempt } from '../../packages/core-agent/src/index.ts';
import { AGENT_MODEL_CALL_LIMIT } from '../../packages/core-wire/src/index.ts';
import { final, reads, scripted, TASK } from './agent-ports.ts';

const LIMIT = 3;

it('a task read then a final answer is success, the tool call carried back as it came', async () => {
  const run = scripted((n) => (n === 1 ? reads(1) : final(2)));
  const end = await runAttempt(run.state, run.ports, LIMIT, 'The task.');
  expect(end).toEqual({ outcome: 'success', endCode: 'COMPLETED' });
  expect(run.ended).toEqual([]);
  expect(run.toolRuns()).toBe(1);
  expect(run.sent.map((turn) => turn.turnOrdinal)).toEqual([0, 1]);
  expect(run.sent[0]?.tools).toEqual(['task.read']);
  expect(run.sent[1]?.parts).toEqual([
    { ref: 'task', taskId: TASK, revision: 3 },
    {
      ref: 'answer',
      callId: 'answer_1',
      text: 'Reading the task.',
      toolCalls: [{ id: 'call_1', name: 'task.read', args: { taskId: TASK } }],
    },
    { ref: 'task', taskId: TASK, revision: 3, toolCallId: 'call_1' },
  ]);
});

it("the server's settlement of the limit-th call ends it call_limit, never success", async () => {
  // A final answer at the limit is still the limit: the conservative rule.
  const run = scripted((n) => (n < LIMIT ? reads(n) : { ...final(n), terminal: 'call_limit' }));
  const end = await runAttempt(run.state, run.ports, LIMIT, 'The task.');
  expect(end).toEqual({ outcome: 'call_limit', endCode: 'CALL_LIMIT_REACHED' });
  expect(run.sent).toHaveLength(LIMIT);
  expect(run.ended, 'the server wrote it; the worker writes nothing').toEqual([]);
});

it('a final answer below the limit succeeds', async () => {
  const run = scripted((n) => (n < 2 ? reads(n) : final(n)));
  const end = await runAttempt(run.state, run.ports, LIMIT, 'The task.');
  expect(end.outcome).toBe('success');
  expect(run.sent).toHaveLength(2);
});

it("LangChain's limit raises before a send past it, and the run ends call_limit through run.end, not as a draft", async () => {
  // The server here never ends it, so only the local limit can stop it.
  const run = scripted((n) => reads(n));
  const end = await runAttempt(run.state, run.ports, LIMIT, 'The task.');
  expect(end.outcome).not.toBe('success');
  expect(end).toEqual({ outcome: 'call_limit', endCode: 'CALL_LIMIT_REACHED' });
  expect(run.sent, 'no send past the limit').toHaveLength(LIMIT);
  expect(run.ended).toEqual(['CALL_LIMIT_REACHED']);
});

it('at the shipped call limit, a run asking one turn more stops call_limit with no turn past it', async () => {
  // The graph's own step limit is sized from the call limit, so the call limit,
  // never the graph, ends a run that keeps reading (#1717 R8b, S2092-2).
  const run = scripted((n) => reads(n));
  const end = await runAttempt(run.state, run.ports, AGENT_MODEL_CALL_LIMIT, 'The task.');
  expect(end).toEqual({ outcome: 'call_limit', endCode: 'CALL_LIMIT_REACHED' });
  expect(run.sent, 'no charged turn past the limit').toHaveLength(AGENT_MODEL_CALL_LIMIT);
  expect(run.toolRuns()).toBe(AGENT_MODEL_CALL_LIMIT);
  expect(run.ended).toEqual(['CALL_LIMIT_REACHED']);
});

it('at the shipped call limit, a final answer on the last allowed turn succeeds', async () => {
  const run = scripted((n) => (n < AGENT_MODEL_CALL_LIMIT ? reads(n) : final(n)));
  const end = await runAttempt(run.state, run.ports, AGENT_MODEL_CALL_LIMIT, 'The task.');
  expect(end).toEqual({ outcome: 'success', endCode: 'COMPLETED' });
  expect(run.sent).toHaveLength(AGENT_MODEL_CALL_LIMIT);
});

it('a stop the broker recorded is the outcome, and the worker records nothing more', async () => {
  const run = scripted(() => ({ stopped: 'BUDGET_UNAVAILABLE', recorded: true }));
  const end = await runAttempt(run.state, run.ports, LIMIT, 'The task.');
  expect(end).toEqual({ outcome: 'budget_wait', endCode: 'BUDGET_UNAVAILABLE' });
  expect(run.ended).toEqual([]);
});

it('a refused task read ends the run with its own code, recorded through run.end', async () => {
  const run = scripted((n) => (n === 1 ? reads(1) : final(2)));
  const refused = new Map([
    [
      'task.read',
      async () => await Promise.resolve({ refused: 'TOOL_REFUSED' as const, recorded: false }),
    ],
  ]);
  const end = await runAttempt(run.state, { ...run.ports, tools: refused }, LIMIT, 'The task.');
  expect(end).toEqual({ outcome: 'cancelled', endCode: 'TOOL_REFUSED' });
  expect(run.ended).toEqual(['TOOL_REFUSED']);
  expect(run.sent, 'no turn after the refusal').toHaveLength(1);
});

it('an uncatalogued tool asked for ends the run with nothing more sent', async () => {
  const run = scripted(() => ({
    callId: 'answer_1',
    text: 'Deleting.',
    toolCalls: [{ id: 'call_1', name: 'task.delete', args: {} }],
  }));
  const end = await runAttempt(run.state, run.ports, LIMIT, 'The task.');
  expect(end.outcome).toBe('cancelled');
  expect(['TOOL_NOT_CATALOGUED', 'TOOL_REFUSED']).toContain(end.endCode);
  expect(run.sent).toHaveLength(1);
  expect(run.toolRuns()).toBe(0);
});
