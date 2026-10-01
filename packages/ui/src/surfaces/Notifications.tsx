// SPDX-License-Identifier: AGPL-3.0-only
//
// The dock's Notifications panel, `/inbox/` and the bell (MP-7-3, CS-7.28,
// CS-7.29, CS-7.39): the designed face of INB-1's inbox.
//
// It draws `inbox.read` and `inbox.count` as they arrive and changes nothing:
// no mark-read, no clear, no dismiss. Opening the panel, switching tabs,
// opening the closed items or scrolling leave every count where it was. The
// owed figure is always `inbox.count`'s, never a tally of the rows drawn.

import { useState, type ReactElement } from 'react';
import { Empty } from '../primitives/Absence.tsx';
import { TabPanel, TabStrip } from '../primitives/Tabs.tsx';
import { follow, type OpenHow } from './gesture.ts';
import {
  bandHeads,
  bandOf,
  groupsOf,
  liveCount,
  type DrawnItem,
  type InboxBand,
  type InboxGroup,
  type InboxGroupRef,
  type InboxItem,
  type InboxTab,
} from '../state/inbox.ts';

export type { OpenHow } from './gesture.ts';

export interface NotificationsProps {
  /** `inbox.read`'s items, as it returned them. */
  readonly items: readonly InboxItem[];
  /** `inbox.count`'s owed figure. */
  readonly owedCount: number;
  readonly groupOf: (item: InboxItem) => InboxGroupRef;
  readonly taskHref: (key: string) => string;
  readonly onOpenTask: (key: string, how: OpenHow) => void;
  readonly onOpenClient: (key: string, how: OpenHow) => void;
}

const REASON: Readonly<Record<InboxItem['reason'], string>> = {
  decision: 'Decision needed',
  waiting_run: 'Run waiting',
  run_finished: 'Run finished',
  assignment: 'Assigned to you',
  mention: 'Mentioned you',
  incident: 'Incident',
  client_comment: 'Client comment',
};

const TABS: readonly { readonly id: InboxTab; readonly label: string; readonly empty: string }[] = [
  { id: 'owed', label: 'Owed a response', empty: 'Nothing is waiting on your answer.' },
  { id: 'info', label: 'No response needed', empty: 'Nothing new to read.' },
];

const BAND_HEAD: Readonly<Record<Exclude<InboxBand, 'done'>, string>> = {
  owe: 'Owed a response',
  fyi: 'No response needed',
};

const when = new Intl.DateTimeFormat('en-AU', { day: 'numeric', month: 'short' });

function Row(props: { readonly item: DrawnItem; readonly list: NotificationsProps }): ReactElement {
  const { item, list } = props;
  const at = item.closedAt ?? item.raisedAt;
  return (
    <a
      className={`nt__row nt__row--${bandOf(item)}`}
      href={list.taskHref(item.task.key)}
      onClick={(event) => {
        follow(event, (how) => {
          list.onOpenTask(item.task.key, how);
        });
      }}
    >
      <span className="nt__body">
        <span className="nt__text">{item.task.title ?? item.task.key}</span>
        <span className="nt__meta">
          <span className="nt__on">{REASON[item.reason]}</span>{' '}
          <time className="nt__when" dateTime={at}>
            {when.format(new Date(at))}
          </time>
        </span>
      </span>
    </a>
  );
}

function GroupHead(props: {
  readonly group: InboxGroup;
  readonly list: NotificationsProps;
}): ReactElement {
  const { ref, owe } = props.group;
  return (
    <h3 className="nt__ghead">
      {ref.href === undefined ? (
        <span className="nt__gname">{ref.name}</span>
      ) : (
        <a
          className="nt__gname"
          href={ref.href}
          onClick={(event) => {
            follow(event, (how) => {
              props.list.onOpenClient(ref.key, how);
            });
          }}
        >
          {ref.name}
        </a>
      )}
      {owe === 0 ? null : (
        <span className="cbadge" aria-label={`${String(owe)} owed a response`}>
          {owe}
        </span>
      )}
    </h3>
  );
}

/** Closed items, kept for the record, folded under one line that states their count. */
function ClosedTail(props: {
  readonly items: readonly DrawnItem[];
  readonly list: NotificationsProps;
}): ReactElement | null {
  if (props.items.length === 0) return null;
  return (
    <details className="nt__closed">
      <summary className="nt__summary">{`${String(props.items.length)} closed: answered and kept`}</summary>
      {props.items.map((item) => (
        <Row key={item.id} item={item} list={props.list} />
      ))}
    </details>
  );
}

function Group(props: {
  readonly group: InboxGroup;
  readonly heads: boolean;
  readonly list: NotificationsProps;
}): ReactElement {
  const { group, list } = props;
  return (
    <section className="nt__grp">
      <GroupHead group={group} list={list} />
      {(['owe', 'fyi'] as const).map((band) => {
        const rows = group.items.filter((item) => bandOf(item) === band);
        if (rows.length === 0) return null;
        return (
          <div key={band} className={`nt__band nt__band--${band}`}>
            {props.heads ? <p className="nt__bh">{BAND_HEAD[band]}</p> : null}
            {rows.map((item) => (
              <Row key={item.id} item={item} list={list} />
            ))}
          </div>
        );
      })}
      <ClosedTail items={group.items.filter((item) => bandOf(item) === 'done')} list={list} />
    </section>
  );
}

/** A tab's figure, drawn only when there is something to count. */
const badge = (count: number): ReactElement | null =>
  count > 0 ? <span className="cbadge">{count}</span> : null;

interface Pane {
  readonly tab: (typeof TABS)[number];
  readonly groups: readonly InboxGroup[];
}

function Panes(props: {
  readonly panes: readonly Pane[];
  readonly selected: InboxTab;
  readonly list: NotificationsProps & { readonly name: string };
}): ReactElement {
  return (
    <>
      {props.panes.map(({ tab, groups }) => {
        const heads = bandHeads(groups);
        return (
          <TabPanel key={tab.id} name={props.list.name} tab={tab.id} selected={props.selected}>
            <div className="nt__pane">
              {groups.length === 0 ? <Empty look="inline" title={tab.empty} /> : null}
              {groups.map((group) => (
                <Group key={group.ref.key} group={group} heads={heads} list={props.list} />
              ))}
            </div>
          </TabPanel>
        );
      })}
    </>
  );
}

/** The one list the panel and `/inbox/` both draw. */
function NotificationsList(props: NotificationsProps & { readonly name: string }): ReactElement {
  const [selected, setSelected] = useState<InboxTab>('owed');
  const panes: readonly Pane[] = TABS.map((tab) => ({
    tab,
    groups: groupsOf(props.items, tab.id, props.groupOf),
  }));
  if (panes.every((pane) => pane.groups.length === 0)) {
    return (
      <Empty
        title="Nothing is waiting on you."
        description="Assignments, decisions and mentions land here and stay until they are dealt with."
      />
    );
  }
  return (
    <div className="nt">
      {props.owedCount > 0 ? (
        <p className="nt__sum">
          <b>{props.owedCount}</b> owed a response
        </p>
      ) : null}
      <div className="nt__tabs">
        <TabStrip
          label="Notifications"
          name={props.name}
          selected={selected}
          onSelect={(id) => {
            setSelected(id === 'info' ? 'info' : 'owed');
          }}
          tabs={panes.map(({ tab, groups }) => ({
            id: tab.id,
            label: tab.label,
            badge: badge(tab.id === 'owed' ? props.owedCount : liveCount(groups)),
          }))}
        />
      </div>
      <Panes panes={panes} selected={selected} list={props} />
    </div>
  );
}

export function NotificationsPanel(props: NotificationsProps): ReactElement {
  return <NotificationsList {...props} name="notifications" />;
}

/** `/inbox/`: the panel's list in full-page form, one list and one owed count. */
export function InboxPage(props: NotificationsProps): ReactElement {
  return (
    <main className="inbox">
      <h1 className="inbox__head">Inbox</h1>
      <NotificationsList {...props} name="inbox" />
    </main>
  );
}

/** The bell carries `inbox.count` in its first paint; nothing owed draws no badge. */
export function Bell(props: {
  readonly owedCount: number;
  readonly onOpen: () => void;
}): ReactElement {
  const owed = props.owedCount > 0;
  return (
    <button
      type="button"
      className="bell"
      aria-label={
        owed ? `Notifications, ${String(props.owedCount)} owed a response` : 'Notifications'
      }
      onClick={props.onOpen}
    >
      <span className="bell__glyph" aria-hidden="true" />
      {owed ? (
        <span className="cbadge cbadge--corner" aria-hidden="true">
          {props.owedCount}
        </span>
      ) : null}
    </button>
  );
}
