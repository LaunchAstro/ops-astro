// SPDX-License-Identifier: AGPL-3.0-only
//
// C80's rows of the refusal register (`../register.ts`): the live correction's
// codes (release decision 3.4 and cases 4 to 9). They sit beside its records
// so the register stays under the per-file size cap; the register reads them
// with its own table, so each code is still declared once.

export const LIVE_CORRECTION_ROWS = [
  {
    code: 'CHANGE_ENVELOPE_EXCEEDED',
    status: 422,
    meaning: 'The change is more than one word on one line of one file',
    source: 'C80, release decision 3.2',
  },
  {
    code: 'APPROVER_NOT_CONFIGURED',
    status: 409,
    meaning: 'No staff approver is configured for live corrections',
    source: 'C80, TR-S-R4-5',
  },
  {
    code: 'APPROVER_NOT_CONFIGURED_ONE',
    status: 403,
    meaning: 'Only the configured staff approver approves a live correction',
    source: 'C80, TR-S-R4-5',
  },
  {
    code: 'SELF_APPROVAL_REFUSED',
    status: 403,
    meaning: 'The requester cannot approve their own change',
    source: 'C80, release decision 3.4',
  },
] as const;
