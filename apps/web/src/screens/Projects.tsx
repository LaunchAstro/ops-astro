// SPDX-License-Identifier: AGPL-3.0-only
import { NoTasks } from './projects/NoTasks.tsx';
import { useAssignments } from './task/assignment-context.tsx';
import { AssignmentRecoveries } from './task/AssignmentRecovery.tsx';
import { useTimerState } from './task/task-timer-context.tsx';
import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { usePageToolbar, ProjectsBoard, TabPanel, clientFiltersIn } from '@launchastro/ui';
import type { OperationsClient } from '../operations/client.ts';
import { rowOf, rowActions, STAGES, type BoardPanelHost, type RowOpened } from './projects-row.ts';
import type {
  ClientListResult,
  PersonListResult,
  TaskBoardResult,
} from '../../../../packages/core-wire/src/index.ts';
import type { ReadState } from '../data/authorised-read.ts';
import { useBoardLive, useBoardProjectionRead } from '../data/board-live.ts';
import { RecordState } from '../views/record-state.tsx';
import { useRereadOn } from './task/reread-on.ts';
import { pathTo } from '../routes.ts';
import { Inbox } from '../views/inbox.tsx';
import { CreateTask } from './projects/CreateTask.tsx';
import { WorkLog } from './projects/WorkLog.tsx';
import { useSharedTaskPins, TaskPinsNotice } from './task/task-pins-context.tsx';
import { ProjectsTabs } from './projects/ProjectsTabs.tsx';
import { ProjectsToolbar } from './projects/ProjectsToolbar.tsx';
import { TABS, pageAddress, tabInAddress, writeTab } from './projects/tab-address.ts';
import {
  decodeBoardAddress,
  boardBody,
  retainBoardScope,
  type BoardAddress,
} from './projects/scoped-board.ts';
import { useProjectBoardAddress } from './projects/board-address.ts';
import {
  boardAdmission,
  scopedBoardRows,
  revealedBoardQuery,
  boardReading,
} from './projects/scoped-board-rows.ts';
import { BoardCustody } from './projects/board-custody.tsx';
import { useBoardTarget } from './projects/scoped-board-read.ts';
import { todayOn } from './task/due-dates.ts';
import { NO_CLIENTS, clientNamesOf, readClients } from './projects/client-names.ts';

export interface ProjectsProps {
  readonly canFileTask?: boolean;
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

type ProjectsTab = 'board' | 'worklog';

export function Projects(props: ProjectsProps): ReactElement {
  const bar = usePageToolbar();
  const { canFileTask = false, inPanel } = props;
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
      {tab === 'board' ? (
        <ProjectsToolbar bar={inPanel === true ? null : bar} canFileTask={canFileTask} />
      ) : null}
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
  const place = useProjectBoardAddress(props.address, props.inPanel === true, props.hidden);
  const scope = decodeBoardAddress(place.query);
  if (scope.kind === 'invalid') return <p role="alert">{scope.reason}</p>;
  return (
    <ProjectBoardRead
      key={`${props.grantKey}:${JSON.stringify(boardBody(scope))}:${String(place.generation)}`}
      {...props}
      scope={scope}
      place={place}
    />
  );
}
function ProjectBoardRead(
  props: Omit<ProjectsProps, 'navigate'> & {
    readonly hidden: boolean;
    readonly scope: BoardAddress;
    readonly place: ReturnType<typeof useProjectBoardAddress>;
  },
): ReactElement {
  const client = props.client;
  const pins = useSharedTaskPins();
  const { timer, state: timerState } = useTimerState();
  const assignments = useAssignments(client, props.grantKey);
  // The row open beside the board and the door it was opened by (MP-5-8).
  const [opened, setOpened] = useState<RowOpened | null>(null);
  const panel = props.taskPanel;

  const { state, reload, refresh } = useBoardProjectionRead<TaskBoardResult>(client, {
    grantKey: props.grantKey,
    run: () => client.read<TaskBoardResult>('task.board', boardBody(props.scope)),
    isEmpty: (value) => value.tasks.length === 0,
    deps: [client],
  });
  // A change made in the panel is the board's next read, as it is the task page's.
  useRereadOn(panel?.changes ?? 0, reload);
  useRereadOn(timerState.changed, reload);
  useRereadOn(assignments.state.changed, refresh);
  // Same-grant empty rereads retain filters (#902); a new reader opens its own empty state.
  const [drew, setDrew] = useState<string | null>(null);
  useEffect(() => {
    if (state.outcome === 'ready') setDrew(state.grantKey);
    else setDrew((before) => (before === state.grantKey ? before : null));
  }, [state]);
  const board: ReadState<TaskBoardResult> =
    state.outcome === 'empty' && drew === state.grantKey ? { ...state, outcome: 'ready' } : state;
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
  const people = useBoardProjectionRead<PersonListResult>(client, {
    grantKey: props.grantKey,
    run: () => client.read<PersonListResult>('person.list', {}),
    // An answer without its list offers nobody, rather than breaking the board.
    isEmpty: (value) => !Array.isArray(value.persons) || value.persons.length === 0,
    deps: [client],
  });
  const persons = people.state.outcome === 'ready' ? people.state.value.persons : null;
  // At a client filter (a Clients row door) every client the reader reaches (C32)
  // is a Client filter even with no row, and the board waits for them (and past
  // the last address's answer), so a door to a quiet client keeps its filter. A
  // failed read keeps the filters the address asks for, and says it failed.
  const query = props.place.query;
  const named =
    clientFiltersIn(query) > 0 ||
    props.scope.kind === 'aggregate' ||
    props.scope.client !== undefined;
  const reached = useBoardProjectionRead<ClientListResult>(client, {
    grantKey: props.grantKey,
    run: () => readClients(client, named),
    deps: [client, named],
  });
  const clients = useMemo(
    () => (reached.own ? clientNamesOf(reached.state, query) : null),
    [reached.own, reached.state, query],
  );
  // INB-1f: one stream for the tab, shared by the board and the inbox panels.
  const followInbox = useBoardLive(client, props.grantKey);
  useRereadOn(panel?.changes ?? 0, people.reload);
  useRereadOn(panel?.changes ?? 0, reached.reload);
  const { scopedView, personRequired, chips, answer, denied, admitted } = boardAdmission(
    props.scope,
    state,
    people,
    reached,
  );
  const rows =
    answer === null || !admitted
      ? []
      : scopedBoardRows(answer.tasks, props.scope, chips ?? [], todayOn(new Date()));
  const boardQuery = revealedBoardQuery(query, rows, props.scope.target);
  const wrap = useBoardTarget(rows, props.scope.target, props.place.generation, props.hidden);
  const reading = admitted && chips !== null ? boardReading(props.scope, chips, rows) : null;
  const waiting = rows.reduce((sum, task) => sum + (task.todo?.waitingComments ?? 0), 0);
  const empty = scopedView ? <></> : <NoTasks />;
  const drawn =
    admitted && (scopedView || board.outcome !== 'empty') && (!named || clients !== null);

  return (
    <div className="stack" ref={wrap}>
      {reading === null ? null : <p data-board-reading>{reading}</p>}
      {props.scope.client === undefined || waiting === 0 ? null : (
        <p data-board-waiting-count>
          {waiting} {waiting === 1 ? 'message' : 'messages'} waiting on us
        </p>
      )}
      {/* The inbox lives inside Tasks (INB-1g): the working minimum above the board. */}
      <Inbox client={client} grantKey={props.grantKey} follow={followInbox} />
      {/* Keyed on the reader: its lock, refusal and in-flight create are theirs. */}
      <CreateTask key={grantKey} client={client} onCreated={reload} />
      <TaskPinsNotice />

      {said === null ? null : (
        <p className="field__error" role="alert" data-board-refusal>
          {said}
        </p>
      )}
      {personRequired &&
      (people.state.outcome === 'denied' || people.state.outcome === 'unavailable') ? (
        <RecordState state={people.state} subject="person list" onRetry={people.reload}>
          {() => null}
        </RecordState>
      ) : null}
      {reached.state.outcome === 'denied' || reached.state.outcome === 'unavailable' ? (
        <RecordState state={reached.state} subject="client list" onRetry={reached.reload}>
          {() => null}
        </RecordState>
      ) : null}
      {/* Checked custody withdraws the board while preserving its unsent editor and focus. */}
      <RecordState state={board} subject="board" onRetry={reload} keep empty={empty}>
        {() => null}
      </RecordState>
      <BoardCustody drawn={drawn} clear={denied}>
        {answer === null ? null : (
          <>
            <AssignmentRecoveries custody={assignments.custody} tasks={admitted ? rows : []} />
            <ProjectsBoard
              // A new place is a new view: the board opens on it afresh.
              hidden={props.hidden}
              rows={rows.map((task) =>
                Object.assign(rowOf(task), {
                  starred: pins?.pinnedIds.includes(task.id) ?? false,
                }),
              )}
              withheld={admitted ? (answer.withheld ?? 0) : 0}
              changedAt={admitted ? (answer.changedAt ?? null) : null}
              stages={STAGES}
              viewer={admitted ? (answer.viewer ?? null) : null}
              viewerOn={
                !scopedView &&
                !rows.some(
                  (task) => task.id === props.scope.target || task.key === props.scope.target,
                )
              }
              {...(answer.owed === undefined ? {} : { owed: admitted ? answer.owed : 0 })}
              href={(row) => pathTo('agency:task-detail', { key: row.key })}
              actions={rowActions({
                client,
                assignment: assignments.custody,
                people: persons,
                timer,
                href: (key) => pathTo('agency:task-detail', { key }),
                reload,
                onSettled: (text) => {
                  if (live.current === grantKey) setRefused({ grant: grantKey, text });
                },
                ...(panel === undefined ? {} : { panel: { host: panel, opened, setOpened } }),
              })}
              address={boardQuery}
              {...(props.scope.target === undefined ? {} : { target: props.scope.target })}
              clients={clients ?? NO_CLIENTS}
              nothing={<NoTasks />}
              onAddress={(next) => props.place.write(retainBoardScope(query, next))}
            />
          </>
        )}
      </BoardCustody>
    </div>
  );
}
