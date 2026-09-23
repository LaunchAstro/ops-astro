// SPDX-License-Identifier: AGPL-3.0-only
//
// Which HTTP status a refusal is carried under.
//
// This is transport, and the transport reads it rather than declaring it. The
// status is a column of the refusal register (`commands/register.ts`), beside
// the code, its meaning and its visibility, so a code is declared once and a
// code added there without a status is a type error rather than a silent 500.
// The reasons each status was chosen are written on the rows.

import {
  statusOf,
  type RefusalCode,
  type RefusalStatus,
} from '../../packages/core-records/src/commands/register.ts';

export type { RefusalStatus };

export function statusFor(code: RefusalCode): RefusalStatus {
  return statusOf(code);
}
