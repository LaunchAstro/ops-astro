// SPDX-License-Identifier: AGPL-3.0-only
import type {
  ClientView,
  TodoView,
  PersonListResult,
  ClientListResult,
} from '../../../../../packages/core-wire/src/index.ts';
import type { OperationsClient } from '../../operations/client.ts';
import { useRead } from '../../data/use-read.ts';
import { tabRollupFloor } from '../../data/rollup-floor.ts';
import { useRereadOn } from '../task/reread-on.ts';
import { scopeOf, type Chip, type IdentityChip } from './todo-list.ts';
import { bodyOf, wordsOf, type TodoScope } from './todo-scope.ts';

export interface Vocabulary {
  readonly pending: boolean;
  readonly people: PersonListResult['persons'];
  readonly clients: readonly ClientView[];
}
export function useTodoVocabulary(
  client: OperationsClient,
  grantKey: string,
  changes = 0,
): Vocabulary {
  const people = useRead<PersonListResult>({
    grantKey,
    run: () => client.read('person.list', {}),
    deps: [],
    rollup: tabRollupFloor(),
  });
  const clients = useRead<ClientListResult>({
    grantKey,
    run: () => client.read('client.list', {}),
    deps: [],
    rollup: tabRollupFloor(),
  });
  useRereadOn(changes, people.reload);
  useRereadOn(changes, clients.reload);
  const pending =
    !people.own ||
    !clients.own ||
    people.state.outcome === 'loading' ||
    clients.state.outcome === 'loading';
  return {
    pending,
    people: !pending && people.state.outcome === 'ready' ? people.state.value.persons : [],
    clients: !pending && clients.state.outcome === 'ready' ? clients.state.value.clients : [],
  };
}
const normal = (name: string): string => name.trim().toLocaleLowerCase('en-AU');
function identities(
  kind: IdentityChip['kind'],
  name: string,
  vocabulary: Vocabulary,
): readonly IdentityChip[] {
  return kind === 'person'
    ? vocabulary.people
        .filter((p) => normal(p.name) === normal(name))
        .map((p) => ({ kind, value: p.personId, name: p.name }))
    : vocabulary.clients
        .filter((c) => normal(c.name) === normal(name))
        .map((c) => ({ kind, value: c.clientId, name: c.name }));
}
/** Explicit identity tokens support quoted multiword names. Bare quoted permitted names resolve too. */
export function typedScope(query: string, vocabulary: Vocabulary): readonly Chip[] {
  return Array.from(query.matchAll(/(?:\w+:)?"[^"]*"|\S+/gu)).flatMap(
    ([token]): readonly Chip[] => {
      if (token.includes('"') && !/^(?:(?:person|client):)?"[^"]*"$/iu.test(token))
        return [{ kind: 'unresolved', value: token, reason: 'Malformed identity', choices: [] }];
      const typed = /^(person|client):(?<name>.*)$/iu.exec(token);
      const name = (typed?.groups?.['name'] ?? token).replaceAll(/^"|"$/gu, '');
      const kind = typed?.[1]?.toLowerCase();
      const ordinary = scopeOf(token);
      if (
        typed === null &&
        !token.startsWith('"') &&
        ordinary.some((chip) => chip.kind !== 'words')
      )
        return ordinary;
      const choices =
        kind === 'person' || kind === 'client'
          ? identities(kind, name, vocabulary)
          : identities('person', name, vocabulary).concat(identities('client', name, vocabulary));
      if (choices.length === 1) return choices;
      if (choices.length > 1)
        return [{ kind: 'unresolved', value: token, reason: `Choose ${name}`, choices }];
      if (kind === 'person' || kind === 'client')
        return [
          { kind: 'unresolved', value: token, reason: `Unknown ${kind}: ${name}`, choices: [] },
        ];
      const route = /^route:(.*)$/iu.exec(token)?.[1];
      if (route !== undefined) {
        const family = ['Agent', 'Review', 'Team'].find((f) => normal(f) === normal(route));
        return family === 'Agent' || family === 'Review' || family === 'Team'
          ? [{ kind: 'route', value: family }]
          : [{ kind: 'unresolved', value: token, reason: `Unknown route: ${route}`, choices: [] }];
      }
      if (token.includes(':') && !token.startsWith('tag:') && token !== 'due:today')
        return [
          { kind: 'unresolved', value: token, reason: `Unknown scope: ${token}`, choices: [] },
        ];
      return scopeOf(token);
    },
  );
}
export interface ScopedBody {
  readonly body: Readonly<Record<string, string>>;
  readonly blocked: boolean;
  readonly route: TodoView['whoseMove'] | null;
}
/** Different kinds intersect; conflicting identities cannot replace a door's existing scope. */
export function scopedBody(
  base: TodoScope,
  chips: readonly Chip[],
  vocabulary: Vocabulary,
): ScopedBody {
  const body = { ...bodyOf(base) };
  let blocked =
    vocabulary.pending ||
    (base.kind === 'person' &&
      !vocabulary.people.some((person) => person.personId === base.personId)) ||
    (base.kind === 'client' &&
      !vocabulary.clients.some((client) => client.clientId === base.clientId));
  for (const chip of chips) {
    if (chip.kind === 'unresolved') blocked = true;
    if (chip.kind === 'person' || chip.kind === 'client') {
      if (
        chip.kind === 'person' &&
        !vocabulary.people.some((person) => person.personId === chip.value)
      )
        blocked = true;
      if (
        chip.kind === 'client' &&
        !vocabulary.clients.some((client) => client.clientId === chip.value)
      )
        blocked = true;
      if (body[chip.kind] !== undefined && body[chip.kind] !== chip.value) blocked = true;
      body[chip.kind] = chip.value;
    }
  }
  const routes = chipRoutes(base, chips);
  return {
    body,
    blocked: blocked || routes.kind === 'conflict',
    route: routes.kind === 'route' ? routes.value : null,
  };
}

/** Names are drawn from current permitted vocabulary, never carried from an earlier owner. */
export function admittedWords(scope: TodoScope, vocabulary: Vocabulary): string | null {
  if (scope.kind === 'mine') return null;
  if (scope.kind === 'person') {
    const person = vocabulary.people.find((each) => each.personId === scope.personId);
    return person === undefined ? null : wordsOf({ ...scope, name: person.name });
  }
  const client = vocabulary.clients.find((each) => each.clientId === scope.clientId);
  return client === undefined ? null : wordsOf({ ...scope, name: client.name });
}

type ChosenRoute =
  | { readonly kind: 'none' }
  | { readonly kind: 'conflict' }
  | { readonly kind: 'route'; readonly value: TodoView['whoseMove'] };
function chipRoutes(base: TodoScope, chips: readonly Chip[]): ChosenRoute {
  const values = new Set<string>(
    base.kind === 'client' && base.family !== undefined ? [base.family] : [],
  );
  for (const chip of chips)
    if (chip.kind === 'route' || chip.kind === 'move') values.add(chip.value);
  if (values.size === 0) return { kind: 'none' };
  const [value] = values;
  return values.size === 1 && (value === 'Agent' || value === 'Review' || value === 'Team')
    ? { kind: 'route', value }
    : { kind: 'conflict' };
}

/** Reinterpret committed names and choices against this refresh's permitted identities. */
export function admittedChips(chips: readonly Chip[], vocabulary: Vocabulary): readonly Chip[] {
  const current = (chip: IdentityChip): IdentityChip | undefined => {
    const match =
      chip.kind === 'person'
        ? vocabulary.people.find((each) => each.personId === chip.value)
        : vocabulary.clients.find((each) => each.clientId === chip.value);
    return match === undefined ? undefined : { ...chip, name: match.name };
  };
  return chips.map((chip): Chip => {
    if (chip.kind === 'person' || chip.kind === 'client')
      return (
        current(chip) ?? {
          kind: 'unresolved',
          value: '',
          reason: 'Identity unavailable',
          choices: [],
        }
      );
    if (chip.kind !== 'unresolved') return chip;
    const choices = chip.choices.flatMap((choice) => {
      const next = current(choice);
      return next === undefined ? [] : [next];
    });
    return {
      kind: 'unresolved',
      value: '',
      reason: choices.length === 0 ? 'Identity unavailable' : 'Choose a permitted identity',
      choices,
    };
  });
}
