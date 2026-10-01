// SPDX-License-Identifier: AGPL-3.0-only
//
// The inbox inside Tasks (INB-1g), the working minimum on today's board
// screen: the caller's own items and the owed count, from `inbox.read` and
// `inbox.count`, the reads the API and the command line serve. The dock's
// Notifications panel (MP-7-3) and `/inbox/` will read the same list; the
// designed surfaces are theirs, and this is the record of the states.
//
// Opening an item stamps it seen (`inbox.seen`, the recipient's own row) and
// leaves it open and counted: read is not done. The delivery word is the last
// attempt's own state, so asked, accepted, delivered and seen stay four words
// and nothing says delivered when only an attempt was asked or accepted. A
// gone entry names nothing and links nowhere.

import { useEffect, type MouseEvent, type ReactElement } from 'react';
import { CountBadge, Empty } from '@launchastro/ui';
import type {
  InboxCountResult,
  InboxEntry,
  InboxReadResult,
} from '../../../../packages/core-wire/src/index.ts';
import type { OperationsClient } from '../operations/client.ts';
import type { ReadState } from '../data/authorised-read.ts';
import { useRead } from '../data/use-read.ts';
import type { FollowInbox } from '../data/board-live.ts';
import { RecordState } from './record-state.tsx';
import { titleOf } from './task-title.ts';
import { pathTo } from '../routes.ts';
import { say } from '../screens/task/Alerts.tsx';

const REASON: Readonly<Record<InboxEntry['reason'], string>> = {
  decision: 'A decision is waiting for you',
  waiting_run: 'A run is waiting on your move',
  run_finished: 'A run you launched finished',
  assignment: 'Assigned to you',
  mention: 'You were mentioned',
  incident: 'An incident needs you',
  client_comment: 'A client comment names you',
};

const DELIVERY: Readonly<Record<NonNullable<InboxEntry['lastDelivery']>, string>> = {
  asked: 'Asked',
  accepted: 'Accepted, not yet delivered',
  delivered: 'Delivered',
  failed: 'Not delivered',
};

/** Where the item stands, in the words a person reads. */
export function workWord(entry: InboxEntry): string {
  if (entry.workState === 'withdrawn') return 'Withdrawn';
  if (entry.workState === 'cleared') {
    const by = entry.closedBy?.name;
    return by === undefined ? 'Cleared' : `Cleared by ${by}`;
  }
  return entry.owed ? 'Waiting for you' : 'For your information';
}

/** The last attempt's word, or nothing when none was made. Never "delivered" for less. */
export function deliveryWord(entry: InboxEntry): string | null {
  return entry.lastDelivery === null ? null : DELIVERY[entry.lastDelivery];
}

export interface InboxProps {
  readonly client: OperationsClient;
  readonly grantKey: string;
  /** Where opening goes once the stamp settles; the page's own address bar. */
  readonly go?: (href: string) => void;
  /** The tab's stream (INB-1f): the list and the count re-read when it says the inbox changed. */
  readonly follow?: FollowInbox;
}

export function Inbox(props: InboxProps): ReactElement {
  const client = props.client;
  const list = useRead<InboxReadResult>({
    grantKey: props.grantKey,
    run: () => client.read<InboxReadResult>('inbox.read', {}),
    isEmpty: (value) => value.inbox.length === 0,
    deps: [],
  });
  const { follow } = props;
  useEffect(() => follow?.(list.reload), [follow, list.reload]);
  // Stamp seen, then go: the stamp is attention only, so a refused or lost one
  // still opens the task.
  const open = async (entry: InboxEntry, href: string): Promise<void> => {
    await client.mutate('inbox.seen', { itemId: entry.id });
    (props.go ?? ((to: string) => window.location.assign(to)))(href);
  };

  return (
    <section className="card card--flush inbox" aria-labelledby="inbox-heading">
      <Owed client={client} grantKey={props.grantKey} follow={props.follow} />
      <RecordState
        state={list.state}
        subject="inbox"
        onRetry={list.reload}
        empty={<Empty title="Nothing is waiting for you." description="Your inbox is empty." />}
      >
        {(value) => (
          <ul className="inbox__list">
            {value.inbox.map((entry) => (
              <InboxRow
                key={entry.id}
                entry={entry}
                onOpen={(href) => {
                  void open(entry, href);
                }}
              />
            ))}
          </ul>
        )}
      </RecordState>
    </section>
  );
}

/** The heading and the owed count, from `inbox.count`: the same number the API and the command line give. */
function Owed(props: {
  readonly client: OperationsClient;
  readonly grantKey: string;
  readonly follow: FollowInbox | undefined;
}): ReactElement {
  const client = props.client;
  const count = useRead<InboxCountResult>({
    grantKey: props.grantKey,
    run: () => client.read<InboxCountResult>('inbox.count', {}),
    deps: [],
  });
  const { follow } = props;
  useEffect(() => follow?.(count.reload), [follow, count.reload]);
  const owed = count.state.outcome === 'ready' ? count.state.value.owed : null;
  return (
    <div className="card__head">
      <div>
        <h2 id="inbox-heading" className="card__title">
          Inbox <CountBadge count={owed ?? 0} title="Waiting for you" />
        </h2>
        <OwedLine state={count.state} onRetry={count.reload} />
      </div>
    </div>
  );
}

/**
 * The count in words once read. A count that could not be read says so, as
 * any read does: a missing count beside a waiting item would read as nothing owed.
 */
function OwedLine(props: {
  readonly state: ReadState<InboxCountResult>;
  readonly onRetry: () => void;
}): ReactElement | null {
  const state = props.state;
  if (state.outcome === 'loading') return null;
  if (state.outcome === 'ready') {
    const owed = state.value.owed;
    return (
      <p className="card__sub" data-inbox-count={owed}>
        {owed === 1 ? '1 waiting for you' : `${String(owed)} waiting for you`}
      </p>
    );
  }
  return (
    <RecordState state={state} subject="owed count" onRetry={props.onRetry}>
      {() => null}
    </RecordState>
  );
}

/** One entry: why it is here, the task it points at, where it stands. */
function InboxRow(props: {
  readonly entry: InboxEntry;
  readonly onOpen: (href: string) => void;
}): ReactElement {
  const entry = props.entry;
  return (
    <li
      className="lrow lrow--page inbox__item"
      data-inbox-item={entry.id}
      data-work-state={entry.workState}
      data-counted={entry.counted}
    >
      <span className="lrow__main">
        <span className="lrow__title">
          {entry.task === undefined ? (
            <span className="inbox__task" data-access={entry.access}>
              This task is no longer there
            </span>
          ) : (
            <a
              className="inbox__task"
              href={pathTo('agency:task-detail', { key: entry.task.key })}
              onClick={(event: MouseEvent<HTMLAnchorElement>) => {
                event.preventDefault();
                props.onOpen(event.currentTarget.href);
              }}
            >
              {titleOf(entry.task.title)}
            </a>
          )}
        </span>
        <span className="lrow__meta">
          <span className="inbox__reason">{REASON[entry.reason]}</span>
          {' · '}
          <span className="inbox__state">{workWord(entry)}</span>
          <Marks entry={entry} />
        </span>
      </span>
    </li>
  );
}

/** What else a person reads on the row: the run's alert (T2h), the last attempt, and seen. */
function Marks(props: { readonly entry: InboxEntry }): ReactElement {
  const entry = props.entry;
  const delivery = deliveryWord(entry);
  return (
    <>
      {entry.alert === undefined ? null : (
        <span className="inbox__alert" data-alert={entry.alert.kind}>
          {' · '}
          {say(entry.alert)}
        </span>
      )}
      {delivery === null ? null : (
        <span className="inbox__delivery" data-delivery={entry.lastDelivery}>
          {' · '}
          {delivery}
        </span>
      )}
      {entry.seenAt === null ? null : (
        <span className="inbox__seen" data-seen="true">
          {' · '}
          Seen
        </span>
      )}
    </>
  );
}
