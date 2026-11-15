// SPDX-License-Identifier: AGPL-3.0-only
//
// The installation's rows of "Duplicate without contents" (`duplicate-kinds.ts`): the gate items,
// the installation mode and the capture pool review are the installation's own acts, not a task's,
// so a duplicate carries none of them. Kept apart so the declaration keeps under its line cap. A harness.

export const INSTALLATION_DECLARED: Readonly<
  Record<string, { readonly carry: 'not carried'; readonly plant: string }>
> = {
  'operations.record_gate_item': { carry: 'not carried', plant: 'the installation, not a task' },
  'operations.change_installation_mode': { carry: 'not carried', plant: 'the installation' },
  'operations.record_capture_pool_review': { carry: 'not carried', plant: 'the installation' },
};
