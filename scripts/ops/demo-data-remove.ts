// SPDX-License-Identifier: AGPL-3.0-only
//
// The demo data's removal (#2211): the manifest's tasks trashed through the
// product's own command, and nothing else. No command removes a client, a tag
// or a thread (#2209), so those stay, named Demo.
//
// A task whose decision chain does not verify cannot be read: `task.read`
// answers 500 DECISION_INTEGRITY for every task behind the break, whoever
// broke it (`reads/verified-decisions.ts`). Such a task is checked by search
// instead, which shows its title without the decisions, and trashed at the
// revision its last step left in the manifest; a later edit makes that
// revision stale, and the trash is refused.

import {
  applied,
  guarded,
  op,
  PREFIX,
  Refusal,
  type Answer,
  type Body,
  type Made,
  type Manifest,
  type Send,
} from './demo-data-checks.ts';

/**
 * Trash every task the manifest lists, and nothing else. Each is read first,
 * and one whose title is not the demo title it was made with stops the run
 * before any task is trashed. One no longer there is counted as gone.
 */
export async function remove(
  raw: Send,
  manifest: Manifest,
): Promise<{ readonly trashed: number; readonly gone: number }> {
  const tasks = manifest.made.filter((m) => m.kind === 'task');
  const send = guarded(raw, new Set(tasks.map((t) => t.id)), new Set());
  const live: { readonly id: string; readonly revision: number }[] = [];
  for (const task of tasks) {
    // Every read before the first trash.
    // oxlint-disable-next-line no-await-in-loop
    const read = await send('task.read', { recordId: task.id });
    if (read.status === 404) continue;
    // oxlint-disable-next-line no-await-in-loop
    const searched = unverifiable(read) ? bySearch(send, manifest, task) : undefined;
    // oxlint-disable-next-line no-await-in-loop
    const found = searched === undefined ? taskShape(applied(read, 'task.read')) : await searched;
    if (found === undefined) continue;
    const { title, revision } = found;
    if (!title.startsWith(PREFIX) || title !== task.name) {
      throw new Refusal(
        `task ${task.id} is titled '${title}', not the demo's '${String(task.name)}'`,
      );
    }
    live.push({ id: task.id, revision });
  }
  for (const { id, revision } of live) {
    const body = {
      operationId: op(manifest, `remove:${id}:${String(revision)}`),
      recordId: id,
      expectedRevision: revision,
    };
    // oxlint-disable-next-line no-await-in-loop
    applied(await send('task.trash', body), 'task.trash');
  }
  return { trashed: live.length, gone: tasks.length - live.length };
}

function taskShape(answer: Body): { readonly title: string; readonly revision: number } {
  const task = (answer['task'] ?? answer) as Body;
  const fields = (task['fields'] ?? task) as Body;
  return { title: String(fields['title'] ?? ''), revision: Number(task['revision']) };
}

function unverifiable(answer: Answer): boolean {
  return (
    answer.status === 500 && (answer.body as Body | undefined)?.['code'] === 'DECISION_INTEGRITY'
  );
}

/** The task's title as search shows it, at its manifest revision; nothing when it is gone. */
async function bySearch(
  send: Send,
  manifest: Manifest,
  task: Made,
): Promise<{ readonly title: string; readonly revision: number } | undefined> {
  const answer = applied(await send('task.search', { query: String(task.name) }), 'task.search');
  const hit = ((answer['hits'] ?? []) as readonly Body[]).find((h) => h['id'] === task.id);
  if (hit === undefined) return undefined;
  const revisions = manifest.made.flatMap((m) =>
    m.id === task.id && m.revision !== undefined ? [m.revision] : [],
  );
  return { title: String(hit['title']), revision: Math.max(...revisions) };
}
