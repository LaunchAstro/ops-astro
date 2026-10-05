// SPDX-License-Identifier: AGPL-3.0-only
//
// The operands of setup's writes: custody (C31) and the connector fleet
// (MP-14-7a). Spread into `WRITE_OPERANDS`
// in `write-operands.ts`, whose type checks every operand; nothing is imported
// back, so no cycle. Their names, with the setup reads', are
// `SetupCommandName`, part of `CommandName`.

export const SETUP_OPERANDS = {
  // `value` is `any` so a wrong kind is the command's own FIELD_VALUE_INVALID,
  // which names the field and never echoes what was sent.
  'secret.set': { name: 'text', value: 'any', clientId: 'id?|null', expectedRevision: 'any' },
  'secret.clear': { secretId: 'id', expectedRevision: 'any' },
  'connector.repair': { connectionId: 'id', expectedRevision: 'any' },
} as const;

/** Setup's operations, reads and writes: a member of `CommandName`. */
export type SetupCommandName =
  // Custody (C31): the business's secrets, shown only as set or not set. One
  // command serves both secret screens, and no path returns a value.
  | 'secret.list'
  | 'secret.set'
  | 'secret.clear'
  // The connector fleet (MP-14-7a): read by `connection:read`, and a repair
  // started by `custody:manage`, which records it and sends nothing.
  | 'connection.fleet'
  | 'connector.repair';
