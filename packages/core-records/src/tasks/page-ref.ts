// SPDX-License-Identifier: AGPL-3.0-only
//
// A task page's reference (#1467): a conversation's added page `/task/<ref>`
// names a task by its key or its id, the one segment URL-decoded. One parser,
// so what a question resolves to the task (core-commands' `pageTaskOf`) is
// exactly what a purge of that task clears.

const TASK_PAGE = /^\/task\/(?<ref>[^/?#]+)$/u;

/**
 * The decoded reference of a task's page address: undefined when the address
 * is not a task's page, null when it is one whose reference does not decode
 * (it names no task).
 */
export function taskPageRef(address: string | null): string | null | undefined {
  const ref = TASK_PAGE.exec(address ?? '')?.groups?.['ref'];
  if (ref === undefined) return undefined;
  try {
    return decodeURIComponent(ref);
  } catch {
    return null;
  }
}
