// SPDX-License-Identifier: AGPL-3.0-only
//
// Every id a board or task read takes, named in upper case, answers exactly as its lower-case
// spelling: the board with a person and a client narrowing it, and a task's own read, whose rank
// and steps come back out of the rank and family helpers keyed on the row's id.

import { afterAll, beforeAll, expect, it } from 'vitest';
import { serverUrl } from '../acceptance/world.ts';
import { scopeCommand, scopeRead, scopeWorld, type ScopeWorld } from './typed-todo-scope-world.ts';

let w: ScopeWorld;
let step: string;
let onBoard: string;

/** One command's record and revision, or a throw naming its refusal. */
async function done(body: Parameters<typeof scopeCommand>[1]): Promise<[string, number]> {
  const made = await scopeCommand(w, body);
  if (!('recordId' in made) || made.recordId === null || made.revision === null)
    throw new Error(`Expected ${body.command} to apply`);
  return [made.recordId, made.revision];
}

beforeAll(async () => {
  if (serverUrl === undefined) return;
  w = await scopeWorld();
  [step] = await done({
    command: 'task.create',
    fields: { title: 'Typed scope step of own work' },
    parentId: w.own,
  });
  // A task on the board, the teammate's, for client A: the narrowed board serves it.
  const [id, created] = await done({
    command: 'task.create',
    fields: { title: 'Typed scope on the board' },
  });
  const [, partied] = await done({
    command: 'task.set_party',
    recordId: id,
    expectedRevision: created,
    fields: { client: w.clientA },
  });
  const [, assigned] = await done({
    command: 'task.assign',
    recordId: id,
    expectedRevision: partied,
    fields: { assignee: w.teammate.personId },
  });
  await done({ command: 'task.move', recordId: id, expectedRevision: assigned, board: w.teamA });
  onBoard = id;
}, 180_000);
afterAll(async () => {
  if (serverUrl === undefined) return;
  await w?.db.drop();
});

it.skipIf(serverUrl === undefined)(
  'a board narrowed to a person and a client reads the same in either spelling of each id',
  async () => {
    const asked = (spell: (id: string) => string) =>
      scopeRead(w, {
        read: 'task.board',
        board: spell(w.teamA),
        person: spell(w.teammate.personId),
        client: spell(w.clientA),
      });
    const lower = await asked((id) => id.toLowerCase());
    expect(lower).toMatchObject({ tasks: [{ id: onBoard }] });
    expect(await asked((id) => id.toUpperCase())).toStrictEqual(lower);
  },
);

it.skipIf(serverUrl === undefined)(
  "a task's read names its rank, its steps and itself in lower case whichever spelling asked",
  async () => {
    const lower = await scopeRead(w, { read: 'task.read', recordId: w.own });
    expect(lower).toMatchObject({ task: { id: w.own, steps: [{ id: step }] } });
    expect(await scopeRead(w, { read: 'task.read', recordId: w.own.toUpperCase() })).toStrictEqual(
      lower,
    );
  },
);
