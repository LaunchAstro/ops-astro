// SPDX-License-Identifier: AGPL-3.0-only
//
// `/inbox/` (MP-7-3, CS-7.39): the kit's InboxPage, the Notifications panel's
// list in full-page form, fed by INB-1's `inbox.read` and `inbox.count` and
// nothing else. It builds no second queue: the entries pass through as the
// read returned them, and the owed figure is the count's, never a tally of
// the rows drawn. What the read withholds is not in its answer, so it is
// never drawn or counted here. It follows the `board` topic, so a new
// notification appears without a reload.
//
// Rows group under the client each entry names: `inbox.read` names it only
// where the reader reaches that client, so an entry without one sits under
// the reader's own work. A client head is a name until the Clients panel
// exists to open it in.

import type { ReactElement } from 'react';
import { InboxPage, type InboxGroupRef, type OpenHow } from '@launchastro/ui';
import type {
  InboxCountResult,
  InboxReadResult,
} from '../../../../packages/core-wire/src/index.ts';
import type { CallResult, OperationsClient } from '../operations/client.ts';
import { useRead } from '../data/use-read.ts';
import { hubOf } from '../data/live.ts';
import { BOARD } from '../data/board-live.ts';
import { RecordState } from '../views/record-state.tsx';
import { pathTo } from '../routes.ts';

/** The group of an entry that names no client: the reader's own work. */
const OWN_WORK: InboxGroupRef = { key: 'own', name: 'Your work' };

/** Each entry's group, by the client the read named on it. */
function groupsByEntry(items: Inbox['items']): (item: { readonly id: string }) => InboxGroupRef {
  const refs = new Map(
    items.flatMap((entry) =>
      entry.client === undefined
        ? []
        : [[entry.id, { key: entry.client.clientId, name: entry.client.name }] as const],
    ),
  );
  return (item) => refs.get(item.id) ?? OWN_WORK;
}

const taskHref = (key: string): string => pathTo('agency:task-detail', { key });

interface Inbox {
  readonly items: InboxReadResult['inbox'];
  readonly owed: number;
}

/** Both reads, or the first one's refusal or outage: the page draws one answer. */
async function readInbox(client: OperationsClient): Promise<CallResult<Inbox>> {
  const listed = await client.read<InboxReadResult>('inbox.read', {});
  if (!('value' in listed)) return listed;
  const counted = await client.read<InboxCountResult>('inbox.count', {});
  if (!('value' in counted)) return counted;
  return { ok: true, value: { items: listed.value.inbox, owed: counted.value.owed } };
}

export function InboxScreen(props: {
  readonly client: OperationsClient;
  readonly grantKey: string;
  readonly navigate: (path: string) => void;
}): ReactElement {
  const { client, navigate } = props;
  const { state, reload } = useRead<Inbox>({
    grantKey: props.grantKey,
    run: async () => await readInbox(client),
    deps: [client],
    // A new notification and the owed count arrive on the board topic (C4).
    live: { hub: hubOf(client), topic: () => BOARD },
  });
  // Beside needs the dock's drawers (MP-3-1); until then both open in place.
  const onOpenTask = (key: string, _how: OpenHow): void => navigate(taskHref(key));
  return (
    <RecordState state={state} subject="inbox" onRetry={reload}>
      {(inbox) => (
        <InboxPage
          items={inbox.items}
          owedCount={inbox.owed}
          groupOf={groupsByEntry(inbox.items)}
          taskHref={taskHref}
          onOpenTask={onOpenTask}
          onOpenClient={() => {}}
        />
      )}
    </RecordState>
  );
}
