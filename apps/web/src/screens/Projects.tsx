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
// as such: the client's name (the client model), the comment counts (INB-1)
// and starring (P-20). The actual is the time logged (MP-4-6).

import { useState, type ReactElement } from 'react';
import { Empty, ProjectsBoard, TabPanel, TabStrip, type ProjectRow } from '@launchastro/ui';
import type { OperationsClient } from '../operations/client.ts';
import { assigneeOf, rowActions, type BoardPanelHost, type RowOpened } from './projects-row.ts';
import { titleOf } from '../views/task-title.ts';
import type {
  BoardTask,
  PersonListResult,
  TaskBoardResult,
} from '../../../../packages/core-wire/src/index.ts';
import { TASK_STAGES, isInProductLink } from '../../../../packages/core-wire/src/index.ts';
import { useRead } from '../data/use-read.ts';
import { useBoardLive } from '../data/board-live.ts';
import { RecordState } from '../views/record-state.tsx';
import { pathTo } from '../routes.ts';
import { Inbox } from '../views/inbox.tsx';
import { CATEGORIES_ARE_MOCK, categoryOf } from './category-mock.ts';
import { CreateTask } from './projects/CreateTask.tsx';
import { WorkLog } from './projects/WorkLog.tsx';

export interface ProjectsProps {
  readonly client: OperationsClient;
  readonly grantKey: string;
  /** Goes to an address inside the application. */
  readonly navigate: (path: string) => void;
  /** The dock task panel (MP-4-8): rows open beside the board through it. Absent, they open the task page. */
  readonly taskPanel?: BoardPanelHost;
}

type ProjectsTab = 'board' | 'worklog';

const TABS = [
  { id: 'board', label: 'Board' },
  { id: 'worklog', label: 'Work log' },
] as const;

const WORK_LOG = '#worklog';

const tabInAddress = (): ProjectsTab =>
  globalThis.location?.hash === WORK_LOG ? 'worklog' : 'board';

/** Keeps the address on the open tab, so a reload lands on it. */
function writeTab(tab: ProjectsTab): void {
  const here = globalThis.location;
  if (here === undefined) return;
  const address = `${here.pathname}${here.search}${tab === 'worklog' ? WORK_LOG : ''}`;
  globalThis.history.replaceState(globalThis.history.state, '', address);
}

export function Projects(props: ProjectsProps): ReactElement {
  const [tab, setTab] = useState<ProjectsTab>(tabInAddress);
  const [workLogOpened, setWorkLogOpened] = useState(tab === 'worklog');
  const select = (id: string): void => {
    const next: ProjectsTab = id === 'worklog' ? 'worklog' : 'board';
    setTab(next);
    if (next === 'worklog') setWorkLogOpened(true);
    writeTab(next);
  };
  return (
    <div className="stack">
      <TabStrip label="Projects" name="projects" tabs={TABS} selected={tab} onSelect={select} />
      <TabPanel name="projects" tab="board" selected={tab}>
        <ProjectBoard
          client={props.client}
          grantKey={props.grantKey}
          {...(props.taskPanel === undefined ? {} : { taskPanel: props.taskPanel })}
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

function ProjectBoard(props: Omit<ProjectsProps, 'navigate'>): ReactElement {
  const client = props.client;
  // The row open beside the board and the door it was opened by (MP-5-8).
  const [opened, setOpened] = useState<RowOpened | null>(null);
  const panel = props.taskPanel;

  const { state, reload } = useRead<TaskBoardResult>({
    grantKey: props.grantKey,
    run: () => client.read<TaskBoardResult>('task.board', { board: null }),
    isEmpty: (value) => value.tasks.length === 0,
    // A change made in the panel is the board's next read, as it is the task page's.
    deps: [panel?.changes ?? 0],
  });

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
  // INB-1f: one stream for the tab, shared by the board and the inbox panels.
  const followInbox = useBoardLive(client, props.grantKey, reload);

  return (
    <div className="stack">
      {/* The inbox lives inside Tasks (INB-1g): the working minimum above the board. */}
      <Inbox client={client} grantKey={props.grantKey} follow={followInbox} />
      <CreateTask client={client} onCreated={reload} />

      <RecordState
        state={state}
        subject="board"
        onRetry={reload}
        empty={
          <Empty
            title="No tasks on this board yet."
            description="You are permitted to see it and it has nothing in it."
            hint="Create one with the form above."
          />
        }
      >
        {(value) => (
          <ProjectsBoard
            rows={value.tasks.map((task) => rowOf(task))}
            withheld={value.withheld ?? 0}
            changedAt={value.changedAt ?? null}
            stages={STAGE_LABELS}
            viewer={value.viewer ?? null}
            {...(value.owed === undefined ? {} : { owed: value.owed })}
            mockCategories={CATEGORIES_ARE_MOCK}
            href={(row) => pathTo('agency:task-detail', { key: row.key })}
            actions={rowActions({
              client,
              tasks: value.tasks,
              people: persons,
              href: (key) => pathTo('agency:task-detail', { key }),
              reload,
              ...(panel === undefined ? {} : { panel: { host: panel, opened, setOpened } }),
            })}
            address={window.location.search}
            onAddress={(query) => {
              window.history.replaceState(
                window.history.state,
                '',
                `${window.location.pathname}${query === '' ? '' : `?${query}`}`,
              );
            }}
          />
        )}
      </RecordState>
    </div>
  );
}

/** The Stage column's vocabulary and the stage editor's choices, in the list's order. */
const STAGE_LABELS = TASK_STAGES.list().map((stage) => stage.label);

/** One task from the read as a Projects board row (MP-5-8). */
function rowOf(task: BoardTask): ProjectRow {
  // A read from a server that predates Assign to AI, or the comment counts,
  // carries none of them: none.
  const read: Partial<Pick<BoardTask, 'agent' | 'myAgents' | 'comments'>> = task;
  const agent = read.agent ?? null;
  return {
    id: task.id,
    key: task.key,
    name: titleOf(task.title),
    rank: { number: task.rank.number, calc: task.rank.calc },
    // No ticket builds starring yet, so the starred tier is empty (P-20).
    starred: false,
    // The client's name waits on the client model; `clientSet` says only
    // that there is one.
    client: null,
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
    // No task category is stored yet: SL08's catalogue replaces this mock seam.
    category: categoryOf(task),
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
