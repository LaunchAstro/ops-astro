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
  {
    code: 'CORRECTION_PARTY_MISMATCH',
    status: 409,
    meaning: 'The correction names a party that is not the client of its task',
    source: 'C80, P26 security review',
  },
  {
    code: 'PAGE_OUTSIDE_PARTY_SITE',
    status: 409,
    meaning: "The correction's page and file are not one pair its client's own site holds",
    source: 'C80, the party-site store',
  },
  {
    code: 'REQUESTER_GRANT_ENDED',
    status: 409,
    meaning: 'The person who asked for the correction no longer holds run:write at its client',
    source: 'C80, the approval checks',
  },
  {
    code: 'CORRECTION_NOT_OWN_WORK',
    status: 409,
    meaning:
      "An agent asks on the business's own site only from a task its owner started that no client, agent or worker has written",
    source: 'R6 part 2, #1699',
  },
  {
    code: 'VERSION_NOT_READY',
    status: 409,
    meaning: 'The correction has no version to decide: it is locating, unlocated or superseded',
    source: '#1693, the guard order',
  },
  {
    code: 'VERSION_UNVERIFIED',
    status: 409,
    meaning: "The site runner has not checked the correction's page in the last 60 seconds",
    source: '#1693, register 65',
  },
] as const;
