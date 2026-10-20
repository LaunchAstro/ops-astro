// SPDX-License-Identifier: AGPL-3.0-only
//
// The agent's tool arguments a turn may carry, each with whether it is kept
// (#2091, gap v2-1): every catalogue operand is a string of 1 to 4,096
// units, the keys exactly the tool's, the whole within 16 KiB. One table,
// so the broker and the plan's reader are judged on the same cases.

const TASK = '00000000-0000-4000-8000-000000000001';
const GOOD = { taskId: TASK, page: 'about', word: 'nine', replacement: 'eight' };

export interface ArgumentCase {
  readonly name: string;
  readonly tool: 'task.read' | 'live_correction.request';
  readonly args: Readonly<Record<string, unknown>>;
  readonly kept: boolean;
}

export const ARGUMENT_CASES: readonly ArgumentCase[] = [
  { name: 'a read of the task', tool: 'task.read', args: { taskId: TASK }, kept: true },
  {
    name: 'a read with an extra key',
    tool: 'task.read',
    args: { taskId: TASK, extra: 1 },
    kept: false,
  },
  { name: 'a read of a number', tool: 'task.read', args: { taskId: 7 }, kept: false },
  { name: 'a read of an empty id', tool: 'task.read', args: { taskId: '' }, kept: false },
  { name: 'a correction of four strings', tool: 'live_correction.request', args: GOOD, kept: true },
  {
    name: 'a correction whose page is an object',
    tool: 'live_correction.request',
    args: { ...GOOD, page: { injected: true } },
    kept: false,
  },
  {
    name: 'a correction whose word is a number',
    tool: 'live_correction.request',
    args: { ...GOOD, word: 123 },
    kept: false,
  },
  {
    name: 'a correction whose replacement is false',
    tool: 'live_correction.request',
    args: { ...GOOD, replacement: false },
    kept: false,
  },
  {
    name: 'a correction with an empty task id',
    tool: 'live_correction.request',
    args: { ...GOOD, taskId: '' },
    kept: false,
  },
  {
    name: 'a correction whose word is 4,097 units',
    tool: 'live_correction.request',
    args: { ...GOOD, word: 'a'.repeat(4097) },
    kept: false,
  },
  {
    name: 'a correction whose word is 4,096 units',
    tool: 'live_correction.request',
    args: { ...GOOD, word: 'a'.repeat(4096) },
    kept: true,
  },
  {
    name: 'a correction missing its replacement',
    tool: 'live_correction.request',
    args: { taskId: TASK, page: 'about', word: 'nine' },
    kept: false,
  },
];
