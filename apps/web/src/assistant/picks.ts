// SPDX-License-Identifier: AGPL-3.0-only
//
// #1666: the live rows of each edit card's pick (`targets.ts`). A card whose
// page has not been read has each target on that page read with `task.read`,
// and only those: a row the reader may not read is left out, and every row
// shows the task's current title and key, never words the model wrote. A card
// whose reply's click froze a choice in this tab comes back with it, on its
// page, before anything is read. The person's moves (a pick, another page) go
// through `moved`, so a choice is only ever a row the card shows.

import { useEffect, useRef } from 'react';
import type { AssistantPick, AssistantPickMove, AssistantPickRow } from '@launchastro/ui';
import type { TaskReadResult } from '../../../../packages/core-wire/src/index.ts';
import type { OperationsClient } from '../operations/client.ts';
import { settle } from '../records/use-command.ts';
import { keyIn, type AssistantState } from './chats.ts';
import { sourceOf } from './proposals.ts';
import type { Store } from './store.ts';
import { moved, restored, shown } from './targets.ts';

const UNTITLED = 'Untitled task';

/** Message `id`'s pick in tab `key`, changed. */
function movePick(
  state: AssistantState,
  key: string,
  id: string,
  change: (pick: AssistantPick) => AssistantPick,
): AssistantState {
  const into = keyIn(state, key);
  const chats = state.chats.map((chat) =>
    chat.key === into
      ? {
          ...chat,
          messages: chat.messages.map((each) => {
            const pick = each.id === id ? each.proposal?.pick : undefined;
            if (each.proposal === undefined || pick === undefined) return each;
            return { ...each, proposal: { ...each.proposal, pick: change(pick) } };
          }),
        }
      : chat,
  );
  return { ...state, chats };
}

/** The rows of the pick's page the reader may read, in the targets' order. */
async function readRows(
  client: OperationsClient,
  pick: AssistantPick,
): Promise<AssistantPickRow[]> {
  const page = shown(pick);
  const reads = await Promise.all(
    page.map((each) => client.read<TaskReadResult>('task.read', { recordId: each.taskId })),
  );
  return reads.flatMap((read, at) => {
    const settled = settle(read);
    const id = page[at]?.taskId;
    if (settled.kind !== 'ok' || !('task' in settled.value) || id === undefined) return [];
    const { task } = settled.value;
    return [{ id, title: task.title ?? UNTITLED, key: task.key }];
  });
}

export interface PickView {
  readonly client: OperationsClient;
  readonly grantKey?: string | undefined;
}

/** Reads each card's page as it is drawn; answers the person's moves on a pick. */
export function usePicks(
  view: PickView,
  store: Store,
): (key: string, id: string, move: AssistantPickMove) => void {
  const out = useRef(new Set<string>());
  useEffect(() => {
    for (const chat of store.state.chats) {
      for (const { id, proposal } of chat.messages) {
        const pick = proposal?.pick;
        const source = sourceOf(id);
        const asked = `${chat.key} ${id} ${String(pick?.page)}`;
        if (pick === undefined || pick.rows !== null || source === null || out.current.has(asked)) {
          continue;
        }
        const back = restored(view.grantKey, source, pick);
        if (back !== pick) {
          store.update((current) => movePick(current, chat.key, id, () => back));
          continue;
        }
        out.current.add(asked);
        void (async () => {
          const rows = await readRows(view.client, pick);
          out.current.delete(asked);
          store.update((current) =>
            movePick(current, chat.key, id, (now) =>
              now.page === pick.page && now.rows === null ? { ...now, rows } : now,
            ),
          );
        })();
      }
    }
  });
  return (key, id, move) => {
    store.update((current) => movePick(current, key, id, (pick) => moved(pick, move)));
  };
}
