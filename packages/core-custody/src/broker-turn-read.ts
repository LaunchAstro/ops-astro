// SPDX-License-Identifier: AGPL-3.0-only
//
// A model turn's bounded parsers (#1623 R3, design R7), steps 1 and 3 of
// `broker-turn.ts`: the turn's shape and order before anything is looked up,
// and its tools once the answers' bytes are bound. Out of shape is
// `TURN_MALFORMED`, never a re-ask.

import { canonicalPayload } from '../../core-digest/src/index.ts';
import { declarationOf, type ToolCall, type TurnPart } from '../../core-wire/src/index.ts';
import type { TurnRequest } from './broker-types.ts';

const MOST_PARTS = 64;
const MOST_ARGUMENT_BYTES = 16 * 1024;

/**
 * A correction's operands, as a person sends them (#1624 R7): the agent's
 * request names exactly the command's declared operands, `{taskId, page,
 * word, replacement}` (#1693), so it asks nothing a person could not, and
 * never a base revision: the M5 pins that (register 65).
 */
const REQUEST_KEYS = Object.keys(declarationOf('live_correction.request').operands ?? {});

/** The longest any operand may be, in UTF-16 units; the command judges its words (#1693). */
const MOST_OPERAND_UNITS = 4096;

/** The tools the catalogue offers a turn (`AGENT_TOOLS`), each with its operands, every one a string. */
const TOOLS: ReadonlyMap<string, readonly string[]> = new Map([
  ['task.read', ['taskId']],
  ['live_correction.request', REQUEST_KEYS],
]);

/** A call's arguments are its tool's operands exactly, each a string of 1 to 4,096 units. */
function argumentsKept(name: string, args: Readonly<Record<string, unknown>>): boolean {
  const operands = TOOLS.get(name);
  return (
    operands !== undefined &&
    keysAre(args, operands) &&
    operands.every((key) => {
      const value = args[key];
      return typeof value === 'string' && value !== '' && value.length <= MOST_OPERAND_UNITS;
    })
  );
}

/** The tool each kind of result answers. */
const ANSWERS: Readonly<Record<'task' | 'correction', string>> = {
  task: 'task.read',
  correction: 'live_correction.request',
};

/** A part whose kind the broker binds nothing to: refused when it is bound. */
export type Part = TurnPart | { readonly ref: 'unbound' };

export interface Turn {
  readonly ordinal: number;
  readonly tools: readonly string[];
  readonly parts: readonly Part[];
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const keysAre = (value: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean =>
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));

const whole = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

function argumentsFit(args: Record<string, unknown>): boolean {
  try {
    return Buffer.byteLength(canonicalPayload(args), 'utf8') <= MOST_ARGUMENT_BYTES;
  } catch {
    return false;
  }
}

function toolCallOf(value: unknown): ToolCall | undefined {
  if (!isObject(value) || !keysAre(value, ['id', 'name', 'args'])) return undefined;
  const { id, name, args } = value;
  if (typeof id !== 'string' || typeof name !== 'string' || !isObject(args)) return undefined;
  return argumentsFit(args) ? { id, name, args } : undefined;
}

function answerOf(value: Record<string, unknown>): Part | undefined {
  const { callId, text, toolCalls } = value;
  if (!keysAre(value, ['ref', 'callId', 'text', 'toolCalls'])) return undefined;
  if (typeof callId !== 'string' || typeof text !== 'string' || !Array.isArray(toolCalls)) {
    return undefined;
  }
  const calls = toolCalls.map((call) => toolCallOf(call));
  if (!calls.every((call) => call !== undefined)) return undefined;
  return { ref: 'answer', callId, text, toolCalls: calls };
}

function taskOf(value: Record<string, unknown>): Part | undefined {
  const { taskId, revision, toolCallId } = value;
  const keys = [
    'ref',
    'taskId',
    'revision',
    ...(Object.hasOwn(value, 'toolCallId') ? ['toolCallId'] : []),
  ];
  if (!keysAre(value, keys) || typeof taskId !== 'string' || !whole(revision)) return undefined;
  if (toolCallId === undefined) return { ref: 'task', taskId, revision };
  return typeof toolCallId === 'string' ? { ref: 'task', taskId, revision, toolCallId } : undefined;
}

function partOf(value: unknown, first: boolean): Part | undefined {
  if (!isObject(value) || typeof value['ref'] !== 'string') return undefined;
  switch (value['ref']) {
    case 'definition': {
      const { path, digest } = value;
      if (!first || !keysAre(value, ['ref', 'path', 'digest'])) return undefined;
      return typeof path === 'string' && typeof digest === 'string'
        ? { ref: 'definition', path, digest }
        : undefined;
    }
    case 'task':
      return taskOf(value);
    case 'correction': {
      const { correctionId, toolCallId } = value;
      if (!keysAre(value, ['ref', 'correctionId', 'toolCallId'])) return undefined;
      return typeof correctionId === 'string' && typeof toolCallId === 'string'
        ? { ref: 'correction', correctionId, toolCallId }
        : undefined;
    }
    case 'answer':
      return answerOf(value);
    default:
      return { ref: 'unbound' };
  }
}

/** Tool-call ids unique, and each result after its call, once. */
function inOrder(parts: readonly Part[]): boolean {
  const asked = new Set<string>();
  const answered = new Set<string>();
  for (const part of parts) {
    if (part.ref === 'answer') {
      for (const call of part.toolCalls) {
        if (asked.has(call.id)) return false;
        asked.add(call.id);
      }
    } else if (
      (part.ref === 'task' || part.ref === 'correction') &&
      part.toolCallId !== undefined
    ) {
      if (!asked.has(part.toolCallId) || answered.has(part.toolCallId)) return false;
      answered.add(part.toolCallId);
    }
  }
  return true;
}

/** Step 1: the turn in shape and order, or undefined (`TURN_MALFORMED`). */
export function readTurn(raw: TurnRequest): Turn | undefined {
  const { turnOrdinal, tools, parts } = raw;
  if (!whole(turnOrdinal) || !Array.isArray(tools) || !Array.isArray(parts)) return undefined;
  if (parts.length === 0 || parts.length > MOST_PARTS) return undefined;
  if (!tools.every((tool) => typeof tool === 'string') || new Set(tools).size !== tools.length) {
    return undefined;
  }
  const read = parts.map((part, index) => partOf(part, index === 0));
  if (!read.every((part) => part !== undefined) || !inOrder(read)) return undefined;
  return { ordinal: turnOrdinal, tools: tools as string[], parts: read };
}

/** Step 3: every tool offered or asked for is the catalogue's, with arguments of its schema. */
export function toolsKept(turn: Turn): boolean {
  if (!turn.tools.every((tool) => TOOLS.has(tool))) return false;
  const offered = new Set(turn.tools);
  const asked = new Map<string, ToolCall>();
  for (const part of turn.parts) {
    if (part.ref === 'answer') {
      for (const call of part.toolCalls) {
        if (!offered.has(call.name) || !argumentsKept(call.name, call.args)) return false;
        asked.set(call.id, call);
      }
    } else if (
      (part.ref === 'task' || part.ref === 'correction') &&
      part.toolCallId !== undefined
    ) {
      const call = asked.get(part.toolCallId);
      // A result answers a call of its own tool, and a read is of the task it asked for.
      if (call?.name !== ANSWERS[part.ref]) return false;
      if (part.ref === 'task' && call.args['taskId'] !== part.taskId) return false;
    }
  }
  return true;
}

/**
 * An answer's calls, before the runner sees any (#2091): each names a tool
 * this turn offered, with its operands exactly and within the bytes a turn
 * carries, under an id used once in the answer and by no earlier call of the
 * turn. One that is not refuses the whole answer.
 */
export function answerCallsKept(turn: Turn, calls: readonly ToolCall[]): boolean {
  const offered = new Set(turn.tools);
  const used = new Set(
    turn.parts.flatMap((part) => (part.ref === 'answer' ? part.toolCalls.map((c) => c.id) : [])),
  );
  return calls.every((call) => {
    const fresh = !used.has(call.id);
    used.add(call.id);
    return (
      fresh &&
      offered.has(call.name) &&
      argumentsKept(call.name, call.args) &&
      argumentsFit(call.args as Record<string, unknown>)
    );
  });
}
