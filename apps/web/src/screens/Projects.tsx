// SPDX-License-Identifier: AGPL-3.0-only
//
// `/projects/`. Two tabs: the caller's inbox above the board of the
// business's unboarded tasks with the form that makes one (CreateTask.tsx),
// and the Work log (MP-8-4), reached by `#worklog` as the mockup's
// `/projects/#worklog` is. The Work log reads nothing until it is first
// opened, and stays drawn once it has been, as every tab pane does.
//
// The read is `task.board` with `board: null`, which the contract defines as
// the business's unboarded tasks — the acceptance case creates a task
// **without a board** and expects to find it (B1).
//
// The board is the board machine with the Projects board's nine columns
// (MP-5-8). Each row is the read's task mapped onto the board's row: the rank
// and its calc line, the stage (drawn by its label in the task stage list),
// the due and the estimate (MP-4-8) come from
// stored records, and the hover door goes to the task's page link (MP-4-12).
// What the product does not store yet draws a dash or nothing and is recorded
// as such: starring (P-20). The actual is the time logged (MP-4-6). The client
// is the read's, by name, where the reader reaches it; a Clients row door (`?f=client:"<name>"`)
// filters the board to it, in the dock as on the page (the view is the address's).

import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { Empty, ProjectsBoard, TabPanel, clientFiltersIn, type ProjectRow } from '@launchastro/ui';
import type { OperationsClient } from '../operations/client.ts';
import { assigneeOf, rowActions, type BoardPanelHost, type RowOpened } from './projects-row.ts';
import { titleOf } from '../views/task-title.ts';
import type {
  BoardTask,
  ClientListResult,
  PersonListResult,
  TaskBoardResult,
} from '../../../../packages/core-wire/src/index.ts';
import {
  TASK_CATEGORIES,
  TASK_STAGES,
  isInProductLink,
} from '../../../../packages/core-wire/src/index.ts';
import { useRead } from '../data/use-read.ts';
import type { ReadState } from '../data/authorised-read.ts';
import { useBoardLive } from '../data/board-live.ts';
import { RecordState } from '../views/record-state.tsx';
import { useRereadOn } from './task/reread-on.ts';
import { pathTo } from '../routes.ts';
import { Inbox } from '../views/inbox.tsx';
import { CreateTask } from './projects/CreateTask.tsx';
import { WorkLog } from './projects/WorkLog.tsx';
import { ProjectsTabs } from './projects/ProjectsTabs.tsx';
import { TABS, pageAddress, tabInAddress, writeTab } from './projects/tab-address.ts';

export interface ProjectsProps {
  readonly client: OperationsClient;
  readonly grantKey: string;
  /** Goes to an address inside the application. */
  readonly navigate: (path: string) => void;
  /** The dock task panel (MP-4-8): rows open beside the board through it. Absent, they open the task page. */
  readonly taskPanel?: BoardPanelHost;
  /** The whole address the board is drawn at, the page's or a panel's place; its query is the view. */
  readonly address?: string;
  /** Drawn in a dock panel: the view stays the panel's own, and the page's address is left alone. */
  readonly inPanel?: boolean;
}

/** The view part of an address (`?f=...`); the page's own query when none is given. */
const queryOf = (address: string | undefined): string =>
  address === undefined ? window.location.search : new URL(address, 'http://here').search;

type ProjectsTab = 'board' | 'worklog';

export function Projects(props: ProjectsProps): ReactElement {
  // The tab is its address's: a panel's own place, never the page's fragment,
  // or the page's. A chosen tab holds while that address does; a new address
  // opens on its own tab, and the Work log, once drawn, stays drawn.
  const here = (): string => (props.inPanel === true ? (props.address ?? '') : pageAddress());
  const address = here();
  const [held, setHeld] = useState(() => ({ address, tab: tabInAddress(address) }));
  const [workLogOpened, setWorkLogOpened] = useState(held.tab === 'worklog');
  if (held.address !== address) {
    const next = tabInAddress(address);
    setHeld({ address, tab: next });
    if (next === 'worklog') setWorkLogOpened(true);
  }
  const tab: ProjectsTab = held.address === address ? held.tab : tabInAddress(address);
  const select = (id: string): void => {
    const next: ProjectsTab = id === 'worklog' ? 'worklog' : 'board';
    if (props.inPanel !== true) writeTab(next);
    setHeld({ address: here(), tab: next });
    if (next === 'worklog') setWorkLogOpened(true);
  };
  return (
    <div className="stack">
      <ProjectsTabs label="Projects" name="projects" tabs={TABS} selected={tab} onSelect={select} />
      <TabPanel name="projects" tab="board" selected={tab}>
        <ProjectBoard
          hidden={tab !== 'board'}
          client={props.client}
          grantKey={props.grantKey}
          {...(props.taskPanel === undefined ? {} : { taskPanel: props.taskPanel })}
          {...(props.address === undefined ? {} : { address: props.address })}
          inPanel={props.inPanel === true}
        />
      </TabPanel>
      <TabPanel name="projects" tab="worklog" selected={tab}>
        {workLogOpened ? (
          <WorkLog client={props.client} grantKey={props.grantKey} navigate={props.navigate} />
        ) : null}
      </TabPanel>
    </div>
  );
}

function ProjectBoard(
  props: Omit<ProjectsProps, 'navigate'> & { readonly hidden: boolean },
): ReactElement {
  const client = props.client;
  // The row open beside the board and the door it was opened by (MP-5-8).
  const [opened, setOpened] = useState<RowOpened | null>(null);
  const panel = props.taskPanel;

  const { state, reload } = useRead<TaskBoardResult>({
    grantKey: props.grantKey,
    run: () => client.read<TaskBoardResult>('task.board', { board: null }),
    isEmpty: (value) => value.tasks.length === 0,
    deps: [],
  });
  // A change made in the panel is the board's next read, as it is the task page's.
  useRereadOn(panel?.changes ?? 0, reload);
  // The last board write's refusal or unknown outcome, in the server's words.
  // It belongs to the grant the write was sent under: another business's
  // board never draws it, a late answer included.
  const [refused, setRefused] = useState<{ grant: string; text: string | null } | null>(null);
  const grantKey = props.grantKey;
  const said = refused?.grant === grantKey ? refused.text : null;
  const live = useRef(grantKey);
  useEffect(() => {
    live.current = grantKey;
  }, [grantKey]);

  // The people the assignee editor offers (MP-5-10); until they answer, the
  // assignee cell draws no editor.
  const people = useRead<PersonListResult>({
    grantKey: props.grantKey,
    run: () => client.read<PersonListResult>('person.list', {}),
    // An answer without its list offers nobody, rather than breaking the board.
    isEmpty: (value) => !Array.isArray(value.persons) || value.persons.length === 0,
    deps: [],
  });
  const persons = people.state.outcome === 'ready' ? people.state.value.persons : null;
  // At a client filter (a Clients row door) every client the reader reaches (C32)
  // is a Client filter even with no row, and the board waits for them, so a door
  // to a quiet client keeps its filter. At none, nothing more is read. A failed
  // read keeps the filters the address asks for, and says it failed.
  const query = queryOf(props.address);
  const named = clientFiltersIn(query) > 0;
  const reached = useRead<ClientListResult>({
    grantKey: props.grantKey,
    run: async () =>
      named
        ? await client.read<ClientListResult>('client.list', {})
        : { ok: true as const, value: { ok: true as const, clients: [] } },
    deps: [named],
  });
  const clients = useMemo(() => clientNamesOf(reached.state, query), [reached.state, query]);
  // INB-1f: one stream for the tab, shared by the board and the inbox panels.
  const followInbox = useBoardLive(client, props.grantKey, reload);

  return (
    <div className="stack">
      {/* The inbox lives inside Tasks (INB-1g): the working minimum above the board. */}
      <Inbox client={client} grantKey={props.grantKey} follow={followInbox} />
      {/* Keyed on the reader: its lock, refusal and in-flight create are theirs. */}
      <CreateTask key={grantKey} client={client} onCreated={reload} />

      {said === null ? null : (
        <p className="field__error" role="alert" data-board-refusal>
          {said}
        </p>
      )}
      {reached.state.outcome === 'denied' || reached.state.outcome === 'unavailable' ? (
        <RecordState state={reached.state} subject="client list" onRetry={reached.reload}>
          {() => null}
        </RecordState>
      ) : null}
      {/*
        Kept drawn while it reads again: a re-read after an edit or a live
        change leaves the filters, an open editor and focus where they were.
      */}
      <RecordState
        state={state}
        subject="board"
        onRetry={reload}
        keep
        empty={
          <Empty
            title="No tasks on this board yet."
            description="You are permitted to see it and it has nothing in it."
            hint="Create one with the form above."
          />
        }
      >
        {(value) =>
          // At a client filter the board waits for the names, so its filter holds.
          named && clients === null ? null : (
            <ProjectsBoard
              // A new place is a new view: the board opens on it afresh.
              key={props.address === undefined ? undefined : query}
              hidden={props.hidden}
              rows={value.tasks.map((task) => rowOf(task))}
              withheld={value.withheld ?? 0}
              changedAt={value.changedAt ?? null}
              stages={STAGE_LABELS}
              viewer={value.viewer ?? null}
              {...(value.owed === undefined ? {} : { owed: value.owed })}
              href={(row) => pathTo('agency:task-detail', { key: row.key })}
              actions={rowActions({
                client,
                people: persons,
                href: (key) => pathTo('agency:task-detail', { key }),
                reload,
                onSettled: (text) => {
                  if (live.current === grantKey) setRefused({ grant: grantKey, text });
                },
                ...(panel === undefined ? {} : { panel: { host: panel, opened, setOpened } }),
              })}
              address={query}
              clients={clients ?? NO_CLIENTS}
              onAddress={(next) => {
                if (props.inPanel === true) return;
                window.history.replaceState(
                  window.history.state,
                  '',
                  `${window.location.pathname}${next === '' ? '' : `?${next}`}`,
                );
              }}
            />
          )
        }
      </RecordState>
    </div>
  );
}

const NO_CLIENTS: readonly string[] = [];

/**
 * The reached clients' names; null while the read is out. A refused or failed
 * read reaches no answer, so the address's own client filters are kept: the
 * board then shows only rows of those clients, never every client's work.
 */
function clientNamesOf(
  state: ReadState<ClientListResult>,
  query: string,
): readonly string[] | null {
  if (state.outcome === 'loading') return null;
  if (state.outcome === 'denied' || state.outcome === 'unavailable') return requestedIn(query);
  const answered = state.outcome === 'ready' || state.outcome === 'empty' ? state.value : null;
  // An answer without its list offers none, rather than breaking the board.
  return Array.isArray(answered?.clients) && answered.clients.length > 0
    ? answered.clients.map((one) => one.name)
    : NO_CLIENTS;
}

/** The client names an address's filters ask for (`client:"<name>"`, the facet id's escapes undone). */
function requestedIn(query: string): readonly string[] {
  return (new URLSearchParams(query).get('f') ?? '').split(',').flatMap((id) => {
    const name = /^client:"(?<name>.*)"$/u.exec(id)?.groups?.['name'];
    return name === undefined ? [] : [name.replaceAll('%2C', ',').replaceAll('%25', '%')];
  });
}

/** The Stage column's vocabulary and the stage editor's choices, in the list's order. */
const STAGE_LABELS = TASK_STAGES.list().map((stage) => stage.label);

/** One task from the read as a Projects board row (MP-5-8). */
function rowOf(task: BoardTask): ProjectRow {
  // A read from a server that predates Assign to AI, the category or the
  // comment counts carries none of them: none.
  const read: Partial<Pick<BoardTask, 'agent' | 'myAgents' | 'category' | 'comments' | 'client'>> =
    task;
  const agent = read.agent ?? null;
  const category = read.category ?? null;
  return {
    id: task.id,
    key: task.key,
    name: titleOf(task.title),
    revision: task.revision,
    rank: { number: task.rank.number, calc: task.rank.calc },
    // No ticket builds starring yet, so the starred tier is empty (P-20).
    starred: false,
    // The client by name where the reader reaches it (C32's rule); a server
    // that predates it, or a client out of reach, sends none.
    client: read.client?.name ?? null,
    assignee: assigneeOf(task, agent),
    // The reader's own agents for the task; the read sends no one else's.
    agents: (read.myAgents ?? []).map((one) => ({ id: one.delegationId, name: one.purpose })),
    // The tick sends the reader's agent's work to review unless it is there.
    toReview:
      agent !== null && task.completedAt === null && task.state?.machineCategory !== 'unstarted',
    due: task.due,
    completed: task.completedAt !== null,
    stage: task.stage === null ? null : TASK_STAGES.labelOf(task.stage),
    status: task.state?.label ?? 'No state',
    statusPosition: task.statePosition,
    // A run awaiting approval is the one wait the read carries; the banner
    // prints the mockup's word for it (B-21).
    waitReason: task.waitReason === 'needs_approval' ? 'approval' : null,
    // The stored category by its label (TASK_CATEGORIES); a value outside
    // the list draws as stored, and none offers no chip (P-13).
    category: category === null ? null : TASK_CATEGORIES.labelOf(category),
    awaitingDecision: task.awaitingDecision,
    estimate:
      task.estimateMinutes === null ? null : { kind: 'time', minutes: task.estimateMinutes },
    // The time logged on the task (MP-4-6); none logged draws a dash.
    actual: task.actualMinutes > 0 ? { kind: 'time', minutes: task.actualMinutes } : null,
    // A stored link that is not an address inside the product is never a
    // door (MP-4-12); the door is then the task's own page.
    ...(isInProductLink(task.pageLink) ? { page: task.pageLink } : {}),
    // The reader's own waiting client signals and mentions (MP-5-8).
    comments: read.comments ?? { client: 0, mentions: 0, latest: null },
  };
}
