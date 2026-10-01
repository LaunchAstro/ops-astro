// SPDX-License-Identifier: AGPL-3.0-only
//
// The refusal register's launch rows (AW-08), split out of `register.ts` by
// ticket to keep it under the product file limit. `register.ts` spreads them
// after its tail, so the rows before them keep their order.

export const LAUNCH_ROWS = [
  // Dispatch releases an effect only for a reviewed output's launch: the plan
  // accept lets work run and fires nothing (`core-runtime/src/reviewed-output.ts`).
  {
    code: 'LAUNCH_NOT_DECIDED',
    status: 409,
    meaning: 'The work was approved as a plan, not launched from its reviewed output',
    source: 'AW-08',
    runtime: true,
  },
] as const;
