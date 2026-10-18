// SPDX-License-Identifier: AGPL-3.0-only
//
// #1531's part of the restricted-calls contract (20261013010100, 20261013010200,
// 20261013044500): an agent's conversation membership, a carried call's record and the one
// session rule, with #1563's answer copy (20261018060000), gathered with MP-14-10a's part in
// `restricted-calls-mandates.ts` and spread into the main lists beside the rest. Apart from
// them to keep each under the line limit.

/**
 * Table grants: a membership closes, and a carried call's times are set, by column grant. A
 * settled call's answer copy is deleted once its reply is kept (#1563).
 */
export const CARRIAGE_GROUPS: readonly (readonly [string, string])[] = [
  ['si', 'conversation_agent_members model_call_carriers'],
  ['sid', 'conversation_answer_copies'],
];

/**
 * Executed: the one session rule, login resolution's and the carriage join's; security
 * invoker, so each reads no more than its caller may.
 */
export const CARRIAGE_EXECUTES: readonly string[] = [
  'ops.session_ended',
  'ops.login_verified_factors',
  'ops.session_refusal',
];

/** Update: a membership closes once; each of a carried call's times is set once. */
export const CARRIAGE_UPDATES = [
  { table: 'public.conversation_agent_members', from: '20261013010100', columns: ['left_at'] },
  {
    table: 'public.model_call_carriers',
    from: '20261013010200',
    columns: ['answer_by', 'offered_at', 'request_at', 'runner', 'send_by'],
  },
] as const;

/** The carriers guard reads the call as the caller, hidden for a foreign business. */
export const CARRIAGE_BEFORE_ROW: Readonly<Record<string, string>> = {
  'public.model_call_carriers': 'constraint',
};

/** A bare membership is open, and its agent is no active agent; a closed copy meets tenancy. */
export const CARRIAGE_BARE_FROM: Readonly<
  Record<string, { readonly from: string; readonly outcome: string }>
> = {
  'public.conversation_agent_members': { from: '20261013010100', outcome: 'constraint' },
};
