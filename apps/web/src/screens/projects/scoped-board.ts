// SPDX-License-Identifier: AGPL-3.0-only
import { TASK_CATEGORIES, type TodoView } from '../../../../../packages/core-wire/src/index.ts';
import { pathTo } from '../../routes.ts';
import type { Chip } from '../todos/todo-list.ts';
import type { ScopedBody } from '../todos/typed-scope.ts';
import type { TodoScope } from '../todos/todo-scope.ts';

type Pool =
  | { readonly kind: 'aggregate' }
  | { readonly kind: 'selected'; readonly boardId: string }
  | { readonly kind: 'unboarded' };
export type BoardAddress = Pool & {
  readonly person?: string;
  readonly client?: string;
  readonly own?: boolean;
  readonly route?: TodoView['whoseMove'];
  readonly filters: readonly Chip[];
  readonly focus: string | null;
  readonly target?: string;
};
const KEYS = [
  'pool',
  'board',
  'scope',
  'person',
  'client',
  'route',
  'filters',
  'focus',
  'target',
] as const;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const taskKey = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/u;
const families = new Set(['Agent', 'Review', 'Team']);
const INVALID_BOARD = { kind: 'invalid', reason: 'The board scope is invalid.' } as const;
export function compactBoardAddress(
  read: ScopedBody,
  scope: TodoScope,
  filters: readonly Chip[],
  focus: string | null,
): string | undefined {
  if (read.blocked) return undefined;
  return encodeBoardAddress({
    kind: 'aggregate',
    ...read.body,
    own: read.body['person'] === undefined && read.body['client'] === undefined,
    ...(read.route === null ? {} : { route: read.route }),
    filters: [
      ...filters.filter((chip) => !['person', 'client', 'route', 'unresolved'].includes(chip.kind)),
      ...(scope.kind === 'client' && scope.waiting === true ? [{ kind: 'waiting' as const }] : []),
    ],
    focus,
  });
}
export function encodeBoardAddress(address: BoardAddress): string {
  const params = new URLSearchParams(
    address.kind === 'aggregate'
      ? { pool: 'aggregate' }
      : { board: address.kind === 'selected' ? address.boardId : 'none' },
  );
  if (address.own === true) params.set('scope', 'own');
  for (const key of ['person', 'client', 'route', 'target'] as const)
    if (address[key] !== undefined) params.set(key, address[key]);
  if (address.filters.length > 0) params.set('filters', JSON.stringify(address.filters));
  if (address.focus !== null) params.set('focus', address.focus);
  return `${pathTo('agency:projects-board')}?${params.toString()}`;
}
function checkedFilters(value: string | null): readonly Chip[] | null {
  if (value === null) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length > 40) return null;
  const chips: Chip[] = [];
  const items: readonly unknown[] = parsed;
  for (const item of items) {
    if (item === null || typeof item !== 'object' || !('kind' in item)) return null;
    const kind = item.kind,
      v = 'value' in item ? item.value : undefined;
    if (Object.keys(item).some((key) => key !== 'kind' && key !== 'value')) return null;
    if (kind === 'waiting' && v === undefined) chips.push({ kind });
    else if (kind === 'due' && (v === 'today' || v === 'overdue' || v === 'soon'))
      chips.push({ kind, value: v });
    else if (
      kind === 'priority' &&
      typeof v === 'number' &&
      Number.isInteger(v) &&
      v >= 1 &&
      v <= 4
    )
      chips.push({ kind, value: v });
    else if (kind === 'move' && (v === 'Agent' || v === 'Review' || v === 'Team'))
      chips.push({ kind, value: v });
    else if (
      kind === 'category' &&
      typeof v === 'string' &&
      TASK_CATEGORIES.list().some((c) => c.id === v)
    )
      chips.push({ kind, value: v });
    else if (
      (kind === 'tag' || kind === 'words') &&
      typeof v === 'string' &&
      v.length > 0 &&
      v.length <= 200
    )
      chips.push({ kind, value: v.toLowerCase() });
    else return null;
  }
  return chips;
}
export function decodeBoardAddress(
  query: string,
): BoardAddress | { readonly kind: 'invalid'; readonly reason: string } {
  const p = new URLSearchParams(query),
    board = p.get('board'),
    mode = p.get('pool'),
    scope = p.get('scope');
  const person = p.get('person'),
    client = p.get('client'),
    route = p.get('route'),
    focus = p.get('focus'),
    target = p.get('target');
  const filters = checkedFilters(p.get('filters'));
  if (
    KEYS.some((key) => p.getAll(key).length > 1) ||
    filters === null ||
    (mode !== null && (mode !== 'aggregate' || board !== null)) ||
    (board !== null && board !== 'none' && !uuid.test(board)) ||
    (scope !== null &&
      (scope !== 'own' || mode !== 'aggregate' || person !== null || client !== null)) ||
    (mode === 'aggregate' && person === null && client === null && scope !== 'own') ||
    (person !== null && !uuid.test(person)) ||
    (client !== null && !uuid.test(client)) ||
    (route !== null && !families.has(route)) ||
    (focus !== null && !taskKey.test(focus)) ||
    (target !== null && !taskKey.test(target)) ||
    (mode === null && board === null && KEYS.some((key) => p.has(key))) ||
    (route !== null && filters.some((chip) => chip.kind === 'move' && chip.value !== route))
  )
    return INVALID_BOARD;
  return {
    ...(mode === 'aggregate'
      ? { kind: 'aggregate' as const }
      : board === null || board === 'none'
        ? { kind: 'unboarded' as const }
        : { kind: 'selected' as const, boardId: board.toLowerCase() }),
    ...(person === null ? {} : { person: person.toLowerCase() }),
    ...(client === null ? {} : { client: client.toLowerCase() }),
    ...(scope === 'own' ? { own: true } : {}),
    ...(route === 'Agent' || route === 'Review' || route === 'Team' ? { route } : {}),
    filters,
    focus,
    ...(target === null ? {} : { target }),
  };
}
export function boardBody(address: BoardAddress): Readonly<Record<string, string | null>> {
  return {
    ...(address.kind === 'aggregate'
      ? { mode: 'aggregate' }
      : { board: address.kind === 'selected' ? address.boardId : null }),
    ...(address.person === undefined ? {} : { person: address.person }),
    ...(address.client === undefined ? {} : { client: address.client }),
  };
}
export function retainBoardScope(query: string, next: string): string {
  const current = new URLSearchParams(query),
    p = new URLSearchParams(next);
  for (const key of KEYS) {
    p.delete(key);
    for (const value of current.getAll(key)) p.append(key, value);
  }
  return p.toString();
}
