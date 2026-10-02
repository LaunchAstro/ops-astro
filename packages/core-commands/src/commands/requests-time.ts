// SPDX-License-Identifier: AGPL-3.0-only
//
// The time tracking shapes of `CommandRequest` (MP-4-6), beside it in
// `requests.ts`, which joins them to its one union with its own envelope. The
// person is the session's, so a body names only the task, or the entry, and
// what to write.

export type TimeRequest<Envelope> =
  | ({ readonly command: 'time.start' | 'time.stop'; readonly taskId: string } & Envelope)
  | ({
      readonly command: 'time.log';
      readonly taskId: string;
      /** What a person types: "1h 30m", "90m" or "90". */
      readonly duration: string;
      readonly note?: string;
    } & Envelope)
  | ({
      readonly command: 'time.set_note';
      readonly entryId: string;
      readonly note: string;
    } & Envelope)
  | ({ readonly command: 'time.delete'; readonly entryId: string } & Envelope);
