// SPDX-License-Identifier: AGPL-3.0-only
//
// A model turn on the wire (#1623 R3, design R4 and R7). The worker sends a
// turn as references to what the broker owns, never as free text: the system
// part names a pinned file the run read, the task part the run's own task at
// a revision, a tool result that same task under the call it answers, and an
// assistant part an earlier answer by its call, carrying the bytes the broker
// returned so the broker can check them against the digest it kept. Each send
// carries its ordinal, which the broker requires to equal the attempt's count
// of calls; the attempt's calls stop at its limit. A correction the agent asked
// for (#1624 R7) comes back as its row, by id, which the broker reads itself.

/** The calls an attempt may make, recorded on the attempt at its first call. */
export const AGENT_MODEL_CALL_LIMIT = 12;

/**
 * The agent's catalogue (#1624 R7): its own task, read, and a correction
 * requested on it as a person's request is. Nothing else, and no tool that
 * reaches outside the app.
 */
export const AGENT_TOOLS: readonly string[] = ['task.read', 'live_correction.request'];

/** A tool the model asked for, as the provider returned it. */
export interface ToolCall {
  readonly id: string;
  readonly name: string;
  readonly args: Readonly<Record<string, unknown>>;
}

export type TurnPart =
  | { readonly ref: 'definition'; readonly path: string; readonly digest: string }
  | {
      readonly ref: 'task';
      readonly taskId: string;
      readonly revision: number;
      /** Set on a tool result: the call it answers. */
      readonly toolCallId?: string;
    }
  | {
      /** A `live_correction.request` result: the row it stored, under the call it answers. */
      readonly ref: 'correction';
      readonly correctionId: string;
      readonly toolCallId: string;
    }
  | {
      readonly ref: 'answer';
      readonly callId: string;
      readonly text: string;
      readonly toolCalls: readonly ToolCall[];
    };
