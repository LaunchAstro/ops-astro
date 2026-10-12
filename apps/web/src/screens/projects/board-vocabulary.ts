// SPDX-License-Identifier: AGPL-3.0-only
//
// The Projects board's vocabulary: the people its assignee editor offers and
// a person-scoped view admits by, and the clients a client filter names. Each
// follows the board's live channel, rereads on a task panel change, and counts
// the answers that break a scoped board's admission, drawn or not.

import { clientFiltersIn } from '@launchastro/ui';
import type {
  ClientListResult,
  PersonListResult,
} from '../../../../../packages/core-wire/src/index.ts';
import { useBoardProjectionRead } from '../../data/board-live.ts';
import type { OperationsClient } from '../../operations/client.ts';
import { useRereadOn } from '../task/reread-on.ts';
import { readClients } from './client-names.ts';
import type { BoardAddress } from './scoped-board.ts';
import { clientBreaks, personBreaks } from './scoped-board-rows.ts';

export function useBoardVocabulary(
  client: OperationsClient,
  grantKey: string,
  scope: BoardAddress,
  query: string,
  /** The task panel's count of changes, each a reread. */
  changes: number,
) {
  // The people the assignee editor offers (MP-5-10); until they answer, the
  // assignee cell draws no editor.
  const people = useBoardProjectionRead<PersonListResult>(client, {
    grantKey,
    run: () => client.read<PersonListResult>('person.list', {}),
    // An answer without its list offers nobody, rather than breaking the board.
    isEmpty: (value) => !Array.isArray(value.persons) || value.persons.length === 0,
    breaks: personBreaks(scope),
    deps: [client],
  });
  // At a client filter (a Clients row door) every client the reader reaches (C32)
  // is a Client filter even with no row, and the board waits for them (and past
  // the last address's answer), so a door to a quiet client keeps its filter. A
  // failed read keeps the filters the address asks for, and says it failed.
  const named =
    clientFiltersIn(query) > 0 || scope.kind === 'aggregate' || scope.client !== undefined;
  const reached = useBoardProjectionRead<ClientListResult>(client, {
    grantKey,
    run: () => readClients(client, named),
    breaks: clientBreaks(scope),
    deps: [client, named],
  });
  // INB-1f: one stream for the tab, shared by the board and the inbox panels.
  useRereadOn(changes, people.reload);
  useRereadOn(changes, reached.reload);
  return { people, reached, named };
}
