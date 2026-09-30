// SPDX-License-Identifier: AGPL-3.0-only
//
// Two tasks the role-case harness (`role-case-harness.ts`) makes for the
// positive recipes that need more than a fresh task: one on a client with a
// person standing on it, which `task.share_with_client` shares with (MP-4-10),
// and one carrying a note its author wrote, which only that author changes
// (MP-4-5).
//
// A harness, not a suite: nothing here runs on its own.

import { randomUUID } from 'node:crypto';
import { issueGrant } from '../../packages/core-records/src/authority/grants.ts';
import type { CommandName } from '../../packages/core-wire/src/surface.ts';
import { insertActor, insertPerson } from '../identity/fixture.ts';
import type { Task } from './role-case-bodies.ts';
import type { Answer, World } from './world.ts';

/** What of the harness the two recipes use. */
interface Deps {
  readonly world: World;
  freshTask(title: string): Promise<Task>;
  asPerson(
    name: CommandName,
    body: Readonly<Record<string, unknown>>,
    businessKey?: string,
    caller?: { readonly token: string },
  ): Promise<Answer>;
  revisionOf(recordId: string): Promise<number>;
}

/**
 * A task on a fresh client, with one person outside the membership standing
 * on that client through a party-scoped `task:read`: the client's existing
 * people `task.share_with_client` shares with (MP-4-10).
 */
async function clientTask({ world, freshTask, asPerson }: Deps, title: string): Promise<Task> {
  const task = await freshTask(title);
  const client = randomUUID();
  const set = await asPerson('task.set_party', {
    recordId: task.id,
    expectedRevision: task.revision,
    fields: { client },
  });
  if (set.code !== 'ok') throw new Error(`matrix: task.set_party refused ${set.code}`);
  await world.db.app.withBusiness(world.alpha, async (tx) => {
    const personId = await insertPerson(tx, 'client person');
    await insertActor(tx, personId);
    const issued = await issueGrant(tx, [], {
      subject: { kind: 'person', id: personId },
      scope: { kind: 'party', id: client },
      collection: 'task',
      action: 'read',
      parentGrantId: null,
      grantedByActorId: world.ada.actorId as string,
    });
    if (!issued.ok) throw new Error(`matrix: party grant refused ${issued.refusal.code}`);
  });
  return { id: task.id, revision: Number(set.body['revision']) };
}

/** A note `author` writes on a fresh task, for the author-only commands (MP-4-5). */
async function ownComment(
  { world, freshTask, asPerson, revisionOf }: Deps,
  author: { readonly token: string } = world.ada,
): Promise<Task & { readonly commentId: string }> {
  const task = await freshTask('a task with a note to change');
  const written = await asPerson(
    'task.comment',
    { recordId: task.id, expectedRevision: task.revision, body: 'a note', audience: 'internal' },
    'alpha',
    author,
  );
  if (written.code !== 'ok') throw new Error(`matrix: task.comment refused ${written.code}`);
  const detail = written.body['detail'] as Record<string, unknown>;
  return { ...task, revision: await revisionOf(task.id), commentId: String(detail['commentId']) };
}

/** The two recipes, bound to the harness that makes them. */
export function ownTaskRecipes(deps: Deps): {
  clientTask(title: string): Promise<Task>;
  ownComment(author?: { readonly token: string }): Promise<Task & { readonly commentId: string }>;
} {
  return {
    clientTask: async (title) => await clientTask(deps, title),
    ownComment: async (author) => await ownComment(deps, author),
  };
}
