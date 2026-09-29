// SPDX-License-Identifier: AGPL-3.0-only
//
// The wayfinder fields on the task spine, and the code the generic editor
// earns for each (`tests/commands/task-fields.test.ts`): the type is
// `task.set_type`'s, the resolution `task.resolve`'s, and the rest are the
// system's.

export const WAYFINDER_FIELD_CODES: Readonly<Record<string, string>> = {
  type: 'TRANSITION_PROTECTED',
  answer: 'TRANSITION_PROTECTED',
  gist: 'TRANSITION_PROTECTED',
  map_owner: 'FIELD_NOT_WRITABLE',
  map_version: 'FIELD_NOT_WRITABLE',
  type_history: 'FIELD_NOT_WRITABLE',
  blocked_by: 'FIELD_NOT_WRITABLE',
  closed_as: 'FIELD_NOT_WRITABLE',
};
