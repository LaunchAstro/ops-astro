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
  {
    code: 'CAPTURE_NOT_CLAIMABLE',
    status: 409,
    meaning: 'Another live lease holds the capture, or it has landed',
    source: 'C35, the capture claim',
  },
  {
    code: 'CAPTURE_NOT_CLAIMED',
    status: 409,
    meaning: 'The capture is not claimed by the lease and fence that land it',
    source: 'C35, the capture land',
  },
  {
    code: 'PICTURE_TOO_LARGE',
    status: 422,
    meaning: 'The picture is past the storage cap',
    source: 'C35, the storage seam',
  },
  {
    code: 'CLIENT_REVIEW_OFF',
    status: 409,
    meaning: 'Client review is switched off; a pin for the client is refused',
    source: 'C35, the pin (DECISIONS 43)',
  },
  {
    code: 'CARRY_NOT_READY',
    status: 409,
    meaning: 'The revision has not landed at every width, so its pins cannot be carried yet',
    source: 'C35-X, the pin carry',
  },
  {
    code: 'POOL_REVIEW_ALREADY_RECORDED',
    status: 409,
    meaning: 'This capture pool review is already recorded; its evidence stays as first recorded',
    source: 'C35, the capture pool reviews (#2018, D17-14)',
  },
] as const;
