// SPDX-License-Identifier: AGPL-3.0-only
//
// A conversation made into the turn the broker reads (#1623 R4, design R5 and
// R7), and judged before anything is sent. Each message becomes a reference
// to what the broker owns, never free text: the system message the run's
// pinned file, the person's message the run's task at the revision it was
// read, an assistant message the answer the broker returned for it, byte for
// byte, and a tool result what that tool call read or stored: the task at
// its revision, or the correction it requested (#1624 R7), by id.
//
// The model does not get to correct itself. Every tool asked for must be in
// the catalogue, every result must answer exactly one earlier call and none
// may be an error, and an attempt already ended stays ended: each of those
// ends the run (`RunEnd`), with nothing sent.

import type { BaseMessage } from '@langchain/core/messages';
import type { EndCode, RunOutcome, ToolCall, TurnPart } from '../../core-wire/src/index.ts';

/** The attempt's stop. `recorded` when the server already wrote its outcome; else `run.end` does. */
export class RunEnd extends Error {
  readonly endCode: EndCode;
  readonly recorded: boolean;
  readonly outcome: RunOutcome | undefined;

  constructor(endCode: EndCode, recorded: boolean, outcome?: RunOutcome) {
    super(`the run ended: ${endCode}`);
    this.name = 'RunEnd';
    this.endCode = endCode;
    this.recorded = recorded;
    this.outcome = outcome;
  }
}

/** What a tool call read or stored, as the broker binds it: never its content. */
export type ToolRead = { readonly revision: number } | { readonly correctionId: string };

/** What one attempt keeps in this process. The model and every binding of it share it. */
export interface AttemptState {
  readonly taskId: string;
  /** The task's revision as the run read it before its first turn. */
  readonly revision: number;
  /** The pinned file the system message stands for, when the run has one. */
  readonly definition?: { readonly path: string; readonly digest: string };
  /** The tools the catalogue offers this attempt, by name. */
  readonly catalogue: readonly string[];
  /** The next turn's ordinal: the calls this attempt has sent. */
  calls: number;
  /** Set once the attempt ends; every later send refuses with it. */
  ended: RunEnd | undefined;
  /** Each answer the broker returned, by its call, as it is carried back. */
  readonly answers: Map<string, TurnPart & { readonly ref: 'answer' }>;
  /** Each tool call's result, by call: the task's revision it read, or the correction it stored. */
  readonly reads: Map<string, ToolRead>;
}

export const attemptState = (
  taskId: string,
  revision: number,
  catalogue: readonly string[],
  definition?: AttemptState['definition'],
): AttemptState => ({
  taskId,
  revision,
  catalogue,
  ...(definition === undefined ? {} : { definition }),
  calls: 0,
  ended: undefined,
  answers: new Map(),
  reads: new Map(),
});

const end = (state: AttemptState, code: EndCode): RunEnd => {
  state.ended ??= new RunEnd(code, false);
  return state.ended;
};

/** The parts of a turn, or the run's end for a conversation it may not send. */
export function partsOf(state: AttemptState, messages: readonly BaseMessage[]): TurnPart[] {
  if (state.ended !== undefined) throw state.ended;
  const parts: TurnPart[] = [];
  const asked = new Set<string>();
  const answered = new Set<string>();
  let task = false;
  for (const [index, message] of messages.entries()) {
    const type = message.getType();
    if (type === 'system' && index === 0 && state.definition !== undefined) {
      parts.push({ ref: 'definition', ...state.definition });
    } else if (type === 'human' && !task && parts.length === index) {
      task = true;
      parts.push({ ref: 'task', taskId: state.taskId, revision: state.revision });
    } else if (type === 'ai') {
      const kept = state.answers.get(String(message.id));
      if (kept === undefined) throw end(state, 'TURN_MALFORMED');
      for (const call of kept.toolCalls) {
        if (!state.catalogue.includes(call.name)) throw end(state, 'TOOL_NOT_CATALOGUED');
        asked.add(call.id);
      }
      parts.push(kept);
    } else if (type === 'tool') {
      const result = message as BaseMessage & { tool_call_id?: string; status?: string };
      const id = String(result.tool_call_id);
      const read = state.reads.get(id);
      if (result.status === 'error' || read === undefined) throw end(state, 'TOOL_REFUSED');
      if (!asked.has(id) || answered.has(id)) throw end(state, 'TURN_MALFORMED');
      answered.add(id);
      parts.push(
        'correctionId' in read
          ? { ref: 'correction', correctionId: read.correctionId, toolCallId: id }
          : { ref: 'task', taskId: state.taskId, revision: read.revision, toolCallId: id },
      );
    } else {
      throw end(state, 'TURN_MALFORMED');
    }
  }
  if (!task) throw end(state, 'TURN_MALFORMED');
  return parts;
}

/** The answer the broker returned, kept so the next turn carries it back unchanged. */
export function keepAnswer(
  state: AttemptState,
  callId: string,
  text: string,
  toolCalls: readonly ToolCall[],
): void {
  state.answers.set(callId, { ref: 'answer', callId, text, toolCalls });
}
