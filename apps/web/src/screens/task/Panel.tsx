// SPDX-License-Identifier: AGPL-3.0-only
//
// The dock task panel's body (MP-4-8, DS-COMP-38): where a task is changed
// beside the page. Its head's New task opens the new-task draft
// (`DraftPanel.tsx`, MP-4-13); the task's client is not on the wire yet
// (`clientSet` only), so a draft filed from here starts with no client. Its own field edits (the name, the assignee and the due
// date) are `PanelFields.tsx`. It mounts the pieces built for it: the
// handling ticks (MP-4-10), the description and agent brief fields (MP-4-7),
// the subtasks and time (MP-4-4, MP-4-6), the conversation (MP-4-5,
// `PanelConversation.tsx`), the folded trail (MP-4-16) and the task page's
// Agent pane (`PanelAgent.tsx`, S3), under the same
// Team and Agent counts and the same facts as the task page (MP-4-3, MP-4-9,
// MP-4-2).
//
// **The frame is not this file's.** Seating, floating, the sheet, back and
// forward and the one close path are the dock's (MP-3-1), which draws this
// body as its `task` panel: there the dock's X is the close (`docked`), and
// it closes through `onClose` as the panel's own Close does elsewhere.
//
// **Its own read, the page's rule.** The panel reads the task through
// `task.read` as the page does, and a write here asks the host to count a
// change (`onChanged`); the host hands the count back to both, so each reads
// again. The panel keeps its last answer drawn meanwhile, so a re-read leaves
// what is typed, the perspective and the folds where they were; the comment
// draft and the timer's stop are held above the read, so a failed one does too.
//
// **Its ids are its own.** The page and the panel are in one document, so
// every id drawn here carries the `panel` scope.
//
// **Escape closes the panel, never a control's Escape.** A key that started in
// a field, a select or a text box is that control's (TR-A3-3).

import { TaskTimerBoundary, useTimerRead, useTimerState } from './task-timer-context.tsx';
import { useEffect, useRef, useState, type KeyboardEvent, type ReactElement } from 'react';
import type { OperationsClient } from '../../operations/client.ts';
import type {
  InternalTaskDetail as Task,
  TaskReadResult,
  TaskStateView,
} from '../../../../../packages/core-wire/src/index.ts';
import { hubOf } from '../../data/live.ts';
import { taskDependencyAdmission, useTaskDependencies } from '../../data/board-live.ts';
import { useRead } from '../../data/use-read.ts';
import { pathTo } from '../../routes.ts';
import { RecordState } from '../../views/record-state.tsx';
import { TaskFacts } from './Facts.tsx';
import { History, useShowTrail } from './History.tsx';
import {
  Perspectives,
  perspectiveCounts,
  stepMarks,
  type ConversationTab,
  type PanelDoor,
  type Perspective,
} from './Perspectives.tsx';
import { PageLink, GoTo } from './PageLink.tsx';
import { AskDoor, PanelAgent } from './PanelAgent.tsx';
import { PanelConversation, useConversationHeld } from './PanelConversation.tsx';
import type { DraftScope } from './DraftPanel.tsx';
import type { ClientSeams } from './client-seam.ts';
import { PanelFields, PanelName } from './PanelFields.tsx';
import { statesOf, withPageDefaults } from './read-defaults.ts';
import { useAssignments } from './assignment-context.tsx';
import { useRereadOn } from './reread-on.ts';
import { TeamSubtasks } from './Subtasks.tsx';
import { useSubtaskDoor } from './subtask-door.ts';
import { HandlingTicks } from './Ticks.tsx';
import { TaskPin, TaskPinsNotice } from './task-pins-context.tsx';
import { DescriptionField } from './Writing.tsx';

/** What opened the panel: the task, the door pressed, and the conversation tab it was pressed on. */
export interface PanelOpening {
  readonly taskKey: string;
  readonly door: PanelDoor;
  readonly tab: ConversationTab | null;
}

/** The Client field's seams (`client-seam.ts`) come in beside the rest. */
export interface TaskPanelProps extends ClientSeams {
  readonly client: OperationsClient;
  readonly grantKey: string;
  readonly opening: PanelOpening;
  /** The host's count of changes made to the task here or on the page: a new count rereads. */
  readonly changes?: number;
  readonly onChanged: () => void;
  readonly onClose: () => void;
  /** Drawn by the dock, whose X closes it: the head draws no Close of its own. */
  readonly docked?: boolean;
  /** The head's New task (MP-4-13): a draft filed from this task. Absent, the door is not drawn live. */
  readonly onNewTask?: (scope: DraftScope) => void;
  readonly onOpenTask?: ((key: string, origin?: HTMLElement) => void) | undefined;
  /** Hand the host this person's timer stop while it runs on the task, or null. */
  readonly onLeaving?: (stop: (() => void) | null) => void;
}

const CONTROLS = new Set(['INPUT', 'SELECT', 'TEXTAREA']);
type Body = TaskPanelProps & {
  readonly fold: ReturnType<typeof useShowTrail>;
  readonly conversation: ReturnType<typeof useConversationHeld>;
};

export function TaskPanel(props: TaskPanelProps): ReactElement {
  return (
    <TaskTimerBoundary client={props.client} grantKey={props.grantKey}>
      <TimerPanel {...props} />
    </TaskTimerBoundary>
  );
}

function TimerPanel(props: TaskPanelProps): ReactElement {
  const { client, opening } = props;
  const fold = useShowTrail(client);
  const timerRead = useTimerRead(client, opening.taskKey);
  const assignments = useAssignments(client, props.grantKey);
  const conversation = useConversationHeld(opening.tab);
  const { state, reload, refresh, own } = useRead<TaskReadResult>({
    grantKey: props.grantKey,
    run: timerRead.run,
    deps: [opening.taskKey],
    // The task's topic on the tab's one live stream (C4), as the task page reads it.
    live: {
      hub: hubOf(client),
      topic: (read) => ('task' in read ? `task:${read.task.id}` : undefined),
    },
  });
  useTaskDependencies(client, props.grantKey, refresh, taskDependencyAdmission(state, own));
  useRereadOn(props.changes ?? 0, reload);
  useRereadOn(timerRead.changed, reload);
  useRereadOn(assignments.state.changed, refresh);
  useTimerStop(props, state.outcome === 'ready' ? state.value : null);
  const body = { ...props, fold, conversation };
  const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    if (event.key !== 'Escape' || event.defaultPrevented) return;
    const target = event.target as HTMLElement;
    if (CONTROLS.has(target.tagName) || target.closest('[role="listbox"]') !== null) return;
    event.preventDefault();
    props.onClose();
  };
  return (
    <aside className="dtp" data-task-panel aria-label="Task panel" onKeyDown={onKeyDown}>
      <RecordState state={state} subject="task" onRetry={reload} keep>
        {(value) =>
          'sharedTask' in value ? (
            <p className="card__sub">
              This task is shared with you; it is changed by its business.
            </p>
          ) : (
            <PanelBody {...body} task={withPageDefaults(value.task)} states={statesOf(value)} />
          )
        }
      </RecordState>
    </aside>
  );
}

function PanelBody(
  props: Body & { readonly task: Task; readonly states: readonly TaskStateView[] },
): ReactElement {
  const { client, task } = props;
  const [perspective, setPerspective] = useState<Perspective>('team');
  const body = useSubtaskDoor(props.opening, task.id, perspective, setPerspective);
  const counts = perspectiveCounts({
    steps: stepMarks(task.steps),
    proposals: task.proposals ?? [],
    stagedOutput: false,
  });
  return (
    <div ref={body} className="stack" data-task={task.id} data-revision={task.revision}>
      <PanelHead {...props} />
      <PanelFields {...props} />
      <PageLink client={client} task={task} onChanged={props.onChanged} />
      <TaskFacts task={task} />
      <HandlingTicks client={client} task={task} onChanged={props.onChanged} />
      <Perspectives
        name="panel-perspective"
        counts={counts}
        selected={perspective}
        onSelect={setPerspective}
        team={
          <>
            <DescriptionField
              client={client}
              recordId={task.id}
              revision={task.revision}
              value={task.description}
              onSaved={props.onChanged}
            />
            <PanelWork {...props} />
            <PanelConversation
              grantKey={props.grantKey}
              client={client}
              task={task}
              held={props.conversation}
              onChanged={props.onChanged}
            />
            <History history={task.history} fold={props.fold} />
          </>
        }
        agent={<PanelAgent {...props} />}
      />
    </div>
  );
}

type SideProps = Body & { readonly task: Task };

/**
 * While this person's timer runs on the task, the host holds its stop: closing
 * the panel or opening another task logs the time through `time.stop`, never
 * discarding it (MP-4-13, DP-07, D-33). The timer is known from the last read
 * that arrived and from a start or stop once answered (the setter handed
 * back), so neither a reread still out nor one that failed drops the stop.
 */
function useTimerStop(props: TaskPanelProps, read: TaskReadResult | null): void {
  const admitted = useRef({ key: props.opening.taskKey, id: null as string | null });
  if (admitted.current.key !== props.opening.taskKey)
    admitted.current = { key: props.opening.taskKey, id: null };
  if (read !== null && 'task' in read) admitted.current.id = read.task.id;
  const { timer, state } = useTimerState();
  const binding = state.binding;
  const taskId =
    binding !== null &&
    (binding.task.id === admitted.current.id ||
      [binding.task.id, binding.task.key].includes(props.opening.taskKey))
      ? binding.task.id
      : null;
  useEffect(() => {
    props.onLeaving?.(taskId === null ? null : () => timer?.stop(taskId));
    return () => {
      props.onLeaving?.(null);
    };
  }, [timer, taskId, props.onLeaving]);
}

/** The subtasks and time, without the doors: this is where their edits happen. */
function PanelWork(props: SideProps): ReactElement {
  const [showAllTime, setShowAllTime] = useState(false);
  return (
    <TeamSubtasks
      client={props.client}
      task={props.task}
      showAllTime={showAllTime}
      onShowAllTime={setShowAllTime}
      onChanged={props.onChanged}
      onOpenPanel={undefined}
      onOpenTask={props.onOpenTask}
      doors={false}
    />
  );
}

/**
 * The head: the task's name, New task (a draft filed from here), Ask about
 * it (DP-09), its own page, and close, which the dock draws instead where it
 * hosts the panel.
 */
function PanelHead(props: SideProps): ReactElement {
  const { task, onNewTask } = props;
  return (
    <div className="dtp__head">
      <h2 className="t-title" data-panel-title>
        <PanelName client={props.client} task={task} onChanged={props.onChanged} />
      </h2>
      <TaskPin taskId={task.id} />
      <button
        className="btn"
        type="button"
        data-panel-head="new"
        disabled={onNewTask === undefined}
        onClick={() => {
          onNewTask?.({ clientId: null, from: task.title ?? task.key });
        }}
      >
        New task
      </button>
      <AskDoor grantKey={props.grantKey} task={task} />
      <a
        className="btn"
        data-panel-head="page"
        href={pathTo('agency:task-detail', { key: task.key })}
      >
        Open its page
      </a>
      <GoTo task={task} />
      <TaskPinsNotice />
      {props.docked === true ? null : (
        <button className="btn" type="button" data-panel-head="close" onClick={props.onClose}>
          Close
        </button>
      )}
    </div>
  );
}
