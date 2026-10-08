// SPDX-License-Identifier: AGPL-3.0-only
import type { BoardTask } from '../../../../../packages/core-wire/src/index.ts';
import type { BoardAddress } from './scoped-board.ts';
import type { Vocabulary } from '../todos/typed-scope.ts';
import { readingOf, scoped, type Chip } from '../todos/todo-list.ts';
export function boardScopeChips(
  scope: BoardAddress,
  vocabulary: Vocabulary,
): readonly Chip[] | null {
  if (vocabulary.pending) return null;
  const chips: Chip[] = [...scope.filters];
  if (scope.person !== undefined) {
    const person = vocabulary.people.find((each) => each.personId === scope.person);
    if (person === undefined) return null;
    chips.push({ kind: 'person', value: person.personId, name: person.name });
  }
  if (scope.client !== undefined) {
    const client = vocabulary.clients.find((each) => each.clientId === scope.client);
    if (client === undefined) return null;
    chips.push({ kind: 'client', value: client.clientId, name: client.name });
  }
  if (scope.route !== undefined) chips.push({ kind: 'route', value: scope.route });
  return chips;
}
export function scopedBoardRows(
  tasks: readonly BoardTask[],
  scope: BoardAddress,
  chips: readonly Chip[],
  today: string,
): readonly BoardTask[] {
  const needsEvidence =
    chips.some((chip) => chip.kind !== 'person' && chip.kind !== 'client') || scope.focus !== null;
  return tasks.filter((task) => {
    if (scope.client !== undefined && task.client?.clientId !== scope.client) return false;
    if (task.todo === undefined)
      return (
        !needsEvidence && (scope.person === undefined || task.assignee?.personId === scope.person)
      );
    return scoped([{ ...task, ...task.todo }], chips, scope.focus, today).length === 1;
  });
}
export function revealedBoardQuery(
  query: string,
  rows: readonly BoardTask[],
  target: string | undefined,
): string {
  if (target === undefined || !rows.some((task) => task.id === target || task.key === target))
    return query;
  const p = new URLSearchParams(query);
  p.delete('q');
  p.delete('mode');
  p.set('f', '');
  return p.toString();
}
export const boardReading = (
  scope: BoardAddress,
  chips: readonly Chip[],
  rows: readonly BoardTask[],
): string | null =>
  readingOf(chips, rows.some((task) => task.key === scope.focus) ? scope.focus : null);
