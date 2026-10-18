// SPDX-License-Identifier: AGPL-3.0-only
//
// A model turn on the wire (#1623 R3, design R4 and R7). The worker sends a
// turn as references to what the broker owns, never as free text: the system
// part names a pinned file the run read, the task part the run's own task at
// a revision, a tool result that same task under the call it answers, and an
// assistant part an earlier answer by its call, carrying the bytes the broker
// returned so the broker can check them against the digest it kept. Each send
// carries its ordinal, which the broker requires to equal the attempt's count
// of calls; the attempt's calls stop at its limit.

/** The calls an attempt may make, recorded on the attempt at its first call. */
export const AGENT_MODEL_CALL_LIMIT = 12;

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
      readonly ref: 'answer';
      readonly callId: string;
      readonly text: string;
      readonly toolCalls: readonly ToolCall[];
    };

/** A `model.call` body of kind `turn`, beside the fields one. */
export interface TurnBody {
  readonly kind: 'turn';
  readonly turnOrdinal: number;
  readonly tools: readonly string[];
  readonly parts: readonly TurnPart[];
}

/** What a settled turn hands back: the answer's bytes, once, on the call that made them. */
export interface TurnAnswer {
  readonly callId: string;
  readonly text: string;
  readonly toolCalls: readonly ToolCall[];
  /** Set on the call that reached the attempt's limit: its settlement ended the attempt. */
  readonly terminal?: 'call_limit';
}
