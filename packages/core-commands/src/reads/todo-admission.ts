// SPDX-License-Identifier: AGPL-3.0-only
import {
  checkAuthority,
  clientsReached,
  isUuid,
  subjectsOf,
} from '../../../core-records/src/index.ts';
import type { Session, TenantQuery } from '../../../core-records/src/index.ts';
import { invalid } from '../commands/operands.ts';
import { refuseNotFound, type CommandRefusal } from '../commands/refusal.ts';
import { listPeople } from './people.ts';
import type { Parsed } from './read-row.ts';
import type { TodoScope } from './todos.ts';

export function parseTodoScope({
  person,
  client,
}: Readonly<Record<string, unknown>>): Parsed<'task.todos'> {
  if (person !== undefined && !(typeof person === 'string' && isUuid(person)))
    return {
      ok: false,
      refusal: invalid('person', 'Send person as a teammate’s person identifier.'),
    };
  if (client !== undefined && !(typeof client === 'string' && isUuid(client)))
    return { ok: false, refusal: invalid('client', 'Send client as the client’s identifier.') };
  return {
    ok: true,
    operands: {
      ...(typeof person === 'string' ? { person: person.toLowerCase() } : {}),
      ...(typeof client === 'string' ? { client: client.toLowerCase() } : {}),
    },
  };
}
export async function admitTodoScope(
  tx: TenantQuery,
  session: Session,
  {
    person,
    client,
  }: { readonly person?: string | undefined; readonly client?: string | undefined },
): Promise<{ readonly scope: TodoScope } | { readonly refusal: CommandRefusal }> {
  if (person !== undefined) {
    const vocabulary = await checkAuthority(tx, subjectsOf(session), {
      collection: 'person',
      action: 'read',
      scope: { kind: 'business', id: null },
    });
    if (!vocabulary.ok) return { refusal: vocabulary.refusal };
    if (!(await listPeople(tx)).some((each) => each.personId === person))
      return { refusal: refuseNotFound() };
  }
  if (
    client !== undefined &&
    !(await clientsReached(tx, subjectsOf(session)))?.some((each) => each.clientId === client)
  )
    return { refusal: refuseNotFound() };
  return {
    scope:
      client === undefined
        ? { person: person ?? session.personId }
        : { client, ...(person === undefined ? {} : { person }) },
  };
}
