// SPDX-License-Identifier: AGPL-3.0-only
//
// `/inbox/` (MP-7-3, CS-7.39): the kit's InboxPage, the Notifications panel's
// list in full-page form, fed by INB-1's `inbox.read` and `inbox.count` and
// nothing else. It builds no second queue: the entries pass through as the
// read returned them, and the owed figure is the count's, never a tally of
// the rows drawn. What the read withholds is not in its answer, so it is
// never drawn or counted here.
//
// INB-1's entry names no client, so every row sits under the business's own
// work until the read carries one; the group heads' client links wait on it.

import type { ReactElement } from 'react';
import { InboxPage, type InboxGroupRef, type OpenHow } from '@launchastro/ui';
import type {
  InboxCountResult,
  InboxReadResult,
} from '../../../../packages/core-wire/src/index.ts';
import type { CallResult, OperationsClient } from '../operations/client.ts';
import { useRead } from '../data/use-read.ts';
import { RecordState } from '../views/record-state.tsx';
import { pathTo } from '../routes.ts';

/** The one group until INB-1's read names a client: the business's own work. */
const OWN_WORK: InboxGroupRef = { key: 'own', name: 'Your work' };

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
  });
  // Beside needs the dock's drawers (MP-3-1); until then both open in place.
  const onOpenTask = (key: string, _how: OpenHow): void => navigate(taskHref(key));
  return (
    <RecordState state={state} subject="inbox" onRetry={reload}>
      {(inbox) => (
        <InboxPage
          items={inbox.items}
          owedCount={inbox.owed}
          groupOf={() => OWN_WORK}
          taskHref={taskHref}
          onOpenTask={onOpenTask}
          onOpenClient={() => {}}
        />
      )}
    </RecordState>
  );
}
