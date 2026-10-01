// SPDX-License-Identifier: AGPL-3.0-only
//
// The refusal code each protected task field earns on the generic editor,
// for `task-fields.test.ts`.
//
// The code each of the nineteen earns, asserted by name rather than by rule,
// so relaxing one is a visible diff (minimum contract 5.3 assertion 2).
// Three kinds, and the difference between them is the point: a field an
// operation owns names that operation, a derived field names nobody
// because no operation takes it as an input, and `source` is a claim of
// authority rather than a write. `intake_state` on update names
// `task.triage` (the root's D03 ruling; it is `SOURCE_SPOOFED` on create).
export const PROTECTED_FIELD_CODES: Readonly<Record<string, string>> = {
  ad_hoc: 'TRANSITION_PROTECTED',
  agent: 'TRANSITION_PROTECTED',
  archived_at: 'FIELD_NOT_WRITABLE',
  archived_why: 'FIELD_NOT_WRITABLE',
  assignee: 'TRANSITION_PROTECTED',
  category: 'TRANSITION_PROTECTED',
  client: 'TRANSITION_PROTECTED',
  client_visible: 'TRANSITION_PROTECTED',
  completed_at: 'FIELD_NOT_WRITABLE',
  confidence: 'TRANSITION_PROTECTED',
  delegate: 'TRANSITION_PROTECTED',
  ease: 'TRANSITION_PROTECTED',
  impact: 'TRANSITION_PROTECTED',
  intake_state: 'TRANSITION_PROTECTED',
  key: 'FIELD_NOT_WRITABLE',
  parent: 'TRANSITION_PROTECTED',
  source: 'SOURCE_SPOOFED',
  stage: 'TRANSITION_PROTECTED',
  state: 'TRANSITION_PROTECTED',
};
