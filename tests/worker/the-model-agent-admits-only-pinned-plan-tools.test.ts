// SPDX-License-Identifier: AGPL-3.0-only
//
// The model agent's check on a plan request that offers tools (#1620 P4).
// Tools are top-level Responses function tools, each exactly `{ type:
// 'function', name, description, parameters, strict: true }` in that order,
// written by `chatgptPlanBody`, after `input` and before `store`. A call's
// earlier `function_call` and its `function_call_output` may be input items
// only when the request offers tools, and an output answers a call made
// before it. `parameters` is the one free JSON, held to a depth and a size.
// Tool choice and parallel calls stay refused.

import { describe, expect, it } from 'vitest';
import { chatOf } from '../../apps/model-agent/request-check.ts';
import {
  CHATGPT_PLAN_PARAMETERS_BYTES,
  CHATGPT_PLAN_PARAMETERS_DEPTH,
  chatgptPlanBody,
  type PlanAsk,
} from '../../packages/core-connectors/src/index.ts';
import { ASK, TOOL, planRequest } from '../custody/fixtures/plan-route-world.ts';

const WITH_TOOLS: PlanAsk = { ...ASK, tools: [TOOL] };
const CALL = { type: 'function_call', call_id: 'call_1', name: TOOL.name, arguments: '{}' };
const OUTPUT = { type: 'function_call_output', call_id: 'call_1', output: 'Saved.' };

/** The body for `ask`, parsed, changed by `change`, and written back. */
function changed(ask: PlanAsk, change: (body: Record<string, unknown>) => void): string {
  const body = JSON.parse(chatgptPlanBody(ask)) as Record<string, unknown>;
  change(body);
  return JSON.stringify(body);
}

const firstTool = (body: Record<string, unknown>): Record<string, unknown> =>
  (body['tools'] as Record<string, unknown>[])[0] ?? {};

/** Parameters nested `depth` objects deep. */
function nested(depth: number): Record<string, unknown> {
  let value: Record<string, unknown> = { type: 'string' };
  for (let at = 1; at < depth; at += 1) value = { items: value };
  return value;
}

describe('a plan request offering tools', () => {
  it('is admitted as built, tools after input and before store', () => {
    const request = planRequest(WITH_TOOLS);
    expect(chatOf(request)).toStrictEqual(request);
    expect(Object.keys(JSON.parse(request.body) as object)).toStrictEqual([
      'model',
      'instructions',
      'input',
      'tools',
      'store',
      'stream',
    ]);
  });

  it('writes each tool in its one order, strict, whatever else the caller put on it', () => {
    const loose = { ...TOOL, strict: false, extra: 1 } as unknown as typeof TOOL;
    const body = JSON.parse(chatgptPlanBody({ ...ASK, tools: [loose] })) as Record<string, unknown>;
    expect(Object.keys(firstTool(body))).toStrictEqual([
      'type',
      'name',
      'description',
      'parameters',
      'strict',
    ]);
    expect(firstTool(body)['strict']).toBe(true);
  });

  it('writes no tools key when the call offers none', () => {
    expect(JSON.parse(chatgptPlanBody(ASK))).not.toHaveProperty('tools');
  });

  it('admits a call and its output as input items', () => {
    const request = planRequest({ ...WITH_TOOLS, input: [...ASK.input, CALL, OUTPUT] } as PlanAsk);
    expect(chatOf(request)).toStrictEqual(request);
  });

  it('admits parameters at their depth limit', () => {
    const deep = { ...TOOL, parameters: nested(CHATGPT_PLAN_PARAMETERS_DEPTH) };
    expect(chatOf(planRequest({ ...ASK, tools: [deep] }))).toBeDefined();
  });
});

// oxlint-disable-next-line max-lines-per-function -- one table of refused shapes
describe('a plan request with tools is refused', () => {
  it.each<[string, (body: Record<string, unknown>) => void]>([
    ['an empty tools list', (body) => (body['tools'] = [])],
    ['tools that are not a list', (body) => (body['tools'] = { a: 1 })],
    ['a tool that is not strict', (body) => (firstTool(body)['strict'] = false)],
    ['a tool of another type', (body) => (firstTool(body)['type'] = 'web_search')],
    ['a tool with an extra key', (body) => (firstTool(body)['cache'] = true)],
    ['a tool with no description', (body) => delete firstTool(body)['description']],
    ['a tool named with a space', (body) => (firstTool(body)['name'] = 'update page')],
    ['a tool named past 64 characters', (body) => (firstTool(body)['name'] = 'a'.repeat(65))],
    ['parameters that are not an object', (body) => (firstTool(body)['parameters'] = ['x'])],
    [
      'parameters one level too deep',
      (body) => (firstTool(body)['parameters'] = nested(CHATGPT_PLAN_PARAMETERS_DEPTH + 1)),
    ],
    [
      'parameters past their size',
      (body) =>
        (firstTool(body)['parameters'] = {
          type: 'object',
          description: 'x'.repeat(CHATGPT_PLAN_PARAMETERS_BYTES),
        }),
    ],
    [
      'two tools of one name',
      (body) => (body['tools'] = [firstTool(body), { ...firstTool(body) }]),
    ],
    ['a tool choice', (body) => (body['tool_choice'] = 'auto')],
    ['parallel tool calls', (body) => (body['parallel_tool_calls'] = false)],
    [
      'an output for a call never made',
      (body) => (body['input'] = [...ASK.input, { ...OUTPUT, call_id: 'call_9' }]),
    ],
    ['an output before its call', (body) => (body['input'] = [...ASK.input, OUTPUT, CALL])],
    [
      'a call with arguments that are not text',
      (body) => (body['input'] = [...ASK.input, { ...CALL, arguments: {} }]),
    ],
    [
      'a call with an extra key',
      (body) => (body['input'] = [...ASK.input, { ...CALL, status: 'completed' }]),
    ],
  ])('%s', (_how, change) => {
    expect(chatOf({ ...planRequest(), body: changed(WITH_TOOLS, change) })).toBeUndefined();
  });

  it('a call or its output without tools offered', () => {
    for (const input of [
      [...ASK.input, CALL],
      [...ASK.input, CALL, OUTPUT],
    ]) {
      const body = changed(ASK, (shape) => (shape['input'] = input));
      expect(chatOf({ ...planRequest(), body })).toBeUndefined();
    }
  });

  it('tools written another way', () => {
    const pinned = chatgptPlanBody(WITH_TOOLS);
    const spaced = pinned.replace('"strict":true', '"strict": true');
    expect(chatOf({ ...planRequest(), body: spaced })).toBeUndefined();
    const reordered = changed(WITH_TOOLS, (body) => {
      const { strict, ...rest } = firstTool(body);
      body['tools'] = [{ strict, ...rest }];
    });
    expect(chatOf({ ...planRequest(), body: reordered })).toBeUndefined();
  });
});
