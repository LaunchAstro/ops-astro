// SPDX-License-Identifier: AGPL-3.0-only
//
// #1623 R4, TEST M3 at the model: every way into the owned model, a direct
// `invoke`, a `bindTools` binding and a `withConfig` binding, takes its
// ordinal from the attempt's one state, so the server's one limit counts
// them all, concurrent calls included: no two sends share an ordinal, and a
// rebuilt binding does not start again at 0. A tool outside the catalogue is
// refused at bind time, and nothing is sent.

import { HumanMessage } from '@langchain/core/messages';
import { tool } from '@langchain/core/tools';
import { describe, expect, it } from 'vitest';
import { OpsAstroChatModel } from '../../packages/core-agent/src/index.ts';
import { final, scripted } from './agent-ports.ts';

const named = (name: string) =>
  tool(async () => await Promise.resolve('read'), {
    name,
    description: name,
    schema: { type: 'object' },
  });

describe('direct and bound model calls share the attempt one count', () => {
  it('direct, bound and configured calls, at once, take distinct ordinals from one count', async () => {
    const run = scripted((n) => final(n));
    const model = new OpsAstroChatModel(run.ports.broker, run.state);
    const input = [new HumanMessage('The task.')];
    await Promise.all([
      model.invoke(input),
      model.bindTools([named('task.read')]).invoke(input),
      model.withConfig({}).invoke(input),
      new OpsAstroChatModel(run.ports.broker, run.state)
        .bindTools([named('task.read')])
        .invoke(input),
    ]);
    expect(run.sent.map((turn) => turn.turnOrdinal).toSorted()).toEqual([0, 1, 2, 3]);
    expect(run.state.calls).toBe(4);
    expect(run.sent.filter((turn) => turn.tools.includes('task.read'))).toHaveLength(2);
  });

  it('a tool outside the catalogue is refused at bind time, with nothing sent', () => {
    const run = scripted((n) => final(n));
    const model = new OpsAstroChatModel(run.ports.broker, run.state);
    expect(() => model.bindTools([named('task.delete')])).toThrow(/TOOL_NOT_CATALOGUED/u);
    expect(run.sent).toEqual([]);
    expect(run.state.ended?.endCode).toBe('TOOL_NOT_CATALOGUED');
  });
});
