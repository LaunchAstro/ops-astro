// SPDX-License-Identifier: AGPL-3.0-only
//
// C35's rows of the refusal register (`../register.ts`, #2011), beside its records so the
// register stays under the per-file size cap; the register reads them with its own table.

export const REVIEW_ROWS = [
  {
    code: 'PAGE_OUTSIDE_HOLDER_SITE',
    status: 409,
    meaning: "The review's page and file are not one pair its task's own site binds",
    source: 'C35, the bound pages (R6-S2)',
  },
  {
    code: 'CAPTURE_ALREADY_ASKED',
    status: 409,
    meaning: "The revision's capture is asked already",
    source: 'C35, the review record',
  },
] as const;
