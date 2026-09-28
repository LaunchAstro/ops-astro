// SPDX-License-Identifier: AGPL-3.0-only
//
// A task's title as a person reads it.
//
// The server can send a task with no title (`TaskSummary.title` is
// `string | null`): a record written without one, or one whose title field was
// cleared outside this screen. Drawing it as it came left an empty line on the
// board and an empty heading on the task page, which reads as a fault rather
// than as a task nobody has named yet.

/** What a task with no title is called wherever its title would be drawn. */
export const UNTITLED = 'Untitled task';

/** The title to draw: the task's own, or the placeholder when it has none. */
export function titleOf(title: string | null): string {
  return title === null || title.trim() === '' ? UNTITLED : title;
}
