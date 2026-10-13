// SPDX-License-Identifier: AGPL-3.0-only
//
// The password reset's part of the restricted-calls contract: C40B's token
// (20261005144947, dropped by 20261013223000), the reset window both resets
// open, and the recovery session's rows (20261013223000). Spread into
// `restricted-calls-cases.ts` and `restricted-calls-catalogue.ts` beside the
// rest, and apart from them to keep both under the line limit.

/**
 * Table grants. C40B's reset token is written once, then spent by its column grant alone. A
 * reset request and a minted recovery link are reached only through their definer functions;
 * a recovery session's window is opened by insert and settled by its column grant alone.
 */
export const RESET_GROUPS: readonly (readonly [string, string])[] = [
  ['si', 'password_reset_tokens'],
  ['', 'ops.password_reset_requests ops.recovery_links'],
  ['si', 'ops.recovery_resets'],
];

/**
 * Tables a later migration dropped, by the first migration they are gone from:
 * a prefix before it holds them with their grants, the full schema does not.
 */
export const DROPPED_TABLES: Readonly<Record<string, string>> = {
  'public.password_reset_tokens': '20261013223000',
};

/**
 * Executed: C40B's token lookup, two ids for one hash, until 20261013223000 drops it; then a
 * reset request counted and recorded under its limits, a minted recovery link consumed, the
 * first business a login is mapped in, and whether an unsettled window's password write could
 * outlive a session (security invoker, so it reads no more than its caller may).
 */
export const RESET_EXECUTES: readonly string[] = [
  'public.password_reset_token_find',
  'ops.password_reset_request',
  'ops.recovery_link_consume',
  'ops.recovery_subject_business',
  'ops.reset_write_open',
];

/** Update by column: C40B's token is spent by `spent_at` alone, until the table is dropped. */
export const RESET_UPDATES = [
  {
    table: 'public.password_reset_tokens',
    from: '20261005144947',
    until: '20261013223000',
    columns: ['spent_at'],
  },
] as const;

const windowGrants = (table: string, from: string, columns: readonly (readonly string[])[]) =>
  columns.map(([act, column]) => ({
    from,
    line: `ops_astro_app ${act ?? ''} ${table}.${column ?? ''}`,
  }));

/** The reset windows' column grants: the application opens one and settles it. */
export const RESET_GRANTS: readonly { readonly from: string; readonly line: string }[] = [
  ...windowGrants('ops.subject_resets', '20261005144947', [
    ['INSERT', 'id'],
    ['INSERT', 'subject_digest'],
    ['SELECT', 'id'],
    ['SELECT', 'open_until'],
    ['SELECT', 'settled_at'],
    ['SELECT', 'subject_digest'],
    ['UPDATE', 'settled_at'],
  ]),
  ...windowGrants('ops.recovery_resets', '20261013223000', [
    ['INSERT', 'reset_id'],
    ['INSERT', 'session_digest'],
    ['INSERT', 'write_until'],
    ['SELECT', 'opened_at'],
    ['SELECT', 'reset_id'],
    ['SELECT', 'session_digest'],
    ['SELECT', 'settled_at'],
    ['SELECT', 'write_until'],
    ['UPDATE', 'settled_at'],
  ]),
];
