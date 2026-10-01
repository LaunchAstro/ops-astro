// SPDX-License-Identifier: AGPL-3.0-only
//
// Whose to-dos the Projects panel lists (MP-7-2, CS-7.4): the reader's own,
// a teammate's, a client's, a client's waiting comments, or a client's route
// family. Pure, so the read's body, the words and the count all come from
// one scope.
//
// **The server reads the scope; the panel only narrows within it.** A
// teammate or a client is sent as `task.todos`'s `person` or `client`, and
// the server filters by it under the reader's own `task:read`. A client's
// waiting comments keeps, of that same answer, the tasks with messages owed,
// so the count a door shows and the rows that land are one derivation.
//
// **The clients are the business's own** (`client.list`, C32). A client's
// route family has no source yet, so the families are made-up and the panel
// draws them under the one shared mock label; the read they send is the real one.

import type { TodoView } from '../../../../../packages/core-wire/src/index.ts';

export type TodoScope =
  | { readonly kind: 'mine' }
  | { readonly kind: 'person'; readonly personId: string; readonly name: string }
  | {
      readonly kind: 'client';
      readonly clientId: string;
      readonly name: string;
      /** Only the tasks with client messages owed a reply. */
      readonly waiting?: boolean;
      /** A route family of the client's work board (Agent, Review, Team). */
      readonly family?: string;
    };

export const MINE: TodoScope = { kind: 'mine' };

/** A client's route families (its work board's Agent, Review and Team routes): made-up, no source yet. */
export const ROUTE_FAMILIES: readonly string[] = ['Agent', 'Review', 'Team'];

/** The `task.todos` body a scope sends. */
export function bodyOf(scope: TodoScope): Readonly<Record<string, string>> {
  if (scope.kind === 'person') return { person: scope.personId };
  if (scope.kind === 'client') return { client: scope.clientId };
  return {};
}

/** A scope's read: a new one is a new list, and nothing of the last one stays drawn. */
export const readKeyOf = (scope: TodoScope): string => JSON.stringify(bodyOf(scope));

/** The scope in words, or null for the reader's own list. */
export function wordsOf(scope: TodoScope): string | null {
  if (scope.kind === 'mine') return null;
  if (scope.kind === 'person') return `${scope.name}’s to-dos`;
  return [
    `${scope.name}’s to-dos`,
    ...(scope.waiting === true ? ['with messages waiting on us'] : []),
    ...(scope.family === undefined ? [] : [`route family ${scope.family}`]),
  ].join(', ');
}

/**
 * The rows a scope keeps of its read's answer. A route family does not narrow
 * yet: no task carries one on this base (the work board's routes), so it is
 * the client's list, said in words, until one does.
 */
export const narrowed = (todos: readonly TodoView[], scope: TodoScope): readonly TodoView[] =>
  scope.kind === 'client' && scope.waiting === true
    ? todos.filter((todo) => todo.waitingComments > 0)
    : todos;

/** The client messages owed a reply across these rows: the count a door shows. */
export const waitingOf = (todos: readonly TodoView[]): number =>
  todos.reduce((sum, todo) => sum + todo.waitingComments, 0);
