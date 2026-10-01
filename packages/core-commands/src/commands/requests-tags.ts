// SPDX-License-Identifier: AGPL-3.0-only
//
// The tag shapes of `CommandRequest` (MP-4-11), beside it in `requests.ts`,
// which joins them to its one union with its own envelope. A new tag names
// only itself; adding and removing name the task and the tag.

export type TagRequest<Envelope> =
  | ({ readonly command: 'tag.create'; readonly name: string } & Envelope)
  | ({
      readonly command: 'task.add_tag' | 'task.remove_tag';
      readonly recordId: string;
      readonly tagId: string;
    } & Envelope);
