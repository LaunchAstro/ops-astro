// SPDX-License-Identifier: AGPL-3.0-only
//
// The duplicate shape of `CommandRequest` (MP-4-8), beside it in `requests.ts`,
// which joins it to its one union with its own envelope: the old task, the
// chosen client and the shell as the person edited it.

export type DuplicateRequest<Envelope> = {
  readonly command: 'task.duplicate';
  readonly recordId: string;
  readonly client: string | null;
  readonly title: string;
  /** Checked by the handler (`tasks-duplicate.ts`), so a non-list is refused by name. */
  readonly stepNames: unknown;
  readonly confirmCarried?: boolean;
} & Envelope;
