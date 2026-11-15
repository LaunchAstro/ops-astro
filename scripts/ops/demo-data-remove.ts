// SPDX-License-Identifier: AGPL-3.0-only
//
// The demo data's removal (#2211): the manifest's tasks trashed through the
// product's own command, and nothing else. No command removes a client, a tag
// or a thread (#2209), so those stay, named Demo.
//
// `task.trash` takes a task's whole subtree and the demo makes no subtask, so a
// listed task is trashed only when its read shows no subtask under it: real
// work filed under a demo task stops the run. Each trash names its one task in
// `onlyRecords`, so a subtask filed between the read and the trash is refused
// by the server under its lock (`TRASH_SUBTREE_CHANGED`, #2525) and nothing is
// trashed with it. Each run sends its trashes under operation ids of its own:
// the register keeps a refusal under its id and replays it, so a rerun after
// the owner has looked must not reuse one. A trash whose answer was lost needs
// no replay either, since the next run's read finds the task gone.
//
// A task whose decision chain does not verify cannot be read (`task.read`
// answers 500 DECISION_INTEGRITY for every task behind the break,
// `reads/verified-decisions.ts`), so what sits under it cannot be seen, and it
// stops the run as well; it is the owner's to look at.

import { randomUUID } from 'node:crypto';
import {
  applied,
  guarded,
  op,
  PREFIX,
  Refusal,
  type Answer,
  type Body,
  type Manifest,
  type Send,
} from './demo-data-checks.ts';

/**
 * Trash every task the manifest lists, and nothing else. Each is read first,
 * and one that cannot be read, whose title is not the demo title it was made
 * with, or with any subtask, stops the run before any task is trashed. One no
 * longer there is counted as gone.
 */
export async function remove(
  raw: Send,
  manifest: Manifest,
): Promise<{ readonly trashed: number; readonly gone: number }> {
  const tasks = manifest.made.filter((m) => m.kind === 'task');
  const listed = new Set(tasks.map((t) => t.id));
  const send = guarded(raw, listed, new Set());
  const live: { readonly id: string; readonly revision: number }[] = [];
  const run = randomUUID();
  for (const task of tasks) {
    // Every read before the first trash.
    // oxlint-disable-next-line no-await-in-loop
    const read = await send('task.read', { recordId: task.id });
    if (read.status === 404) continue;
    if (unverifiable(read)) {
      throw new Refusal(`task ${task.id} cannot be read, so what sits under it cannot be checked`);
    }
    const { title, revision, steps } = taskShape(applied(read, 'task.read'));
    if (!title.startsWith(PREFIX) || title !== task.name) {
      throw new Refusal(
        `task ${task.id} is titled '${title}', not the demo's '${String(task.name)}'`,
      );
    }
    if (steps.length > 0) {
      throw new Refusal(`task ${task.id} has a subtask, and a demo run makes none`);
    }
    live.push({ id: task.id, revision });
  }
  for (const { id, revision } of live) {
    const body = {
      operationId: op(manifest, `remove:${run}:${id}:${String(revision)}`),
      recordId: id,
      expectedRevision: revision,
      onlyRecords: [id],
    };
    // oxlint-disable-next-line no-await-in-loop
    applied(await send('task.trash', body), 'task.trash');
  }
  return { trashed: live.length, gone: tasks.length - live.length };
}

function taskShape(answer: Body): {
  readonly title: string;
  readonly revision: number;
  readonly steps: readonly string[];
} {
  const task = (answer['task'] ?? answer) as Body;
  const fields = (task['fields'] ?? task) as Body;
  const steps = ((task['steps'] ?? []) as readonly Body[]).map((step) => String(step['id']));
  return { title: String(fields['title'] ?? ''), revision: Number(task['revision']), steps };
}

function unverifiable(answer: Answer): boolean {
  return (
    answer.status === 500 && (answer.body as Body | undefined)?.['code'] === 'DECISION_INTEGRITY'
  );
}
