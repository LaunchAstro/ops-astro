// SPDX-License-Identifier: AGPL-3.0-only
//
// The dock task panel's body (MP-4-8, DS-COMP-38): where a task is changed
// beside the page. Its own field edits (the name, the assignee and the due
// date) are `PanelFields.tsx`. It mounts the pieces built for it: the
// handling ticks (MP-4-10), the description and agent brief fields (MP-4-7),
// the subtasks and time (MP-4-4, MP-4-6), the conversation (MP-4-5) and the
// folded trail (MP-4-16), under the same Team and Agent counts and the same
// facts as the task page (MP-4-3, MP-4-9, MP-4-2).
//
// **The frame is not this file's.** Seating, floating, the sheet, back and
// forward and the one close path are the dock frame's (MP-3-1); until it is
// on main this body sits in the shell's panel slot and closes through
// `onClose`.
//
// **Its own read, the page's rule.** The panel reads the task through
// `task.read` as the page does, and a write here asks the host to count a
// change (`onChanged`); the host hands the count back to both the page and
// this panel as a read dependency, so each reads again and draws what the
// server holds.
//
// **Its ids are its own.** The page and the panel are in one document, so
// every id drawn here carries the `panel` scope.
//
// **Escape closes the panel, never a control's Escape.** A key that started in
// a field, a select or a text box is that control's (TR-A3-3).

import { useState, type KeyboardEvent, type ReactElement } from 'react';
import type { OperationsClient } from '../../operations/client.ts';
import type {
  InternalTaskDetail as Task,
  TaskReadResult,
} from '../../../../../packages/core-wire/src/index.ts';
import { useRead } from '../../data/use-read.ts';
import { pathTo } from '../../routes.ts';
import { RecordState } from '../../views/record-state.tsx';
import { Comments, type CommentDraft } from './Comments.tsx';
import { TaskFacts } from './Facts.tsx';
import { History } from './History.tsx';
import {
  Perspectives,
  perspectiveCounts,
  stepMarks,
  type ConversationTab,
  type PanelDoor,
  type Perspective,
} from './Perspectives.tsx';
import { PageLink, pageLinkDoor } from './PageLink.tsx';
import { PanelFields, PanelName } from './PanelFields.tsx';
import { withPageDefaults } from './read-defaults.ts';
import { TeamSubtasks } from './Subtasks.tsx';
import { HandlingTicks } from './Ticks.tsx';
import { BriefField, DescriptionField } from './Writing.tsx';

/** What opened the panel: the task, the door pressed, and the conversation tab it was pressed on. */
export interface PanelOpening {
  readonly taskKey: string;
  readonly door: PanelDoor;
  readonly tab: ConversationTab | null;
}

export interface TaskPanelProps {
  readonly client: OperationsClient;
  readonly grantKey: string;
  readonly opening: PanelOpening;
  /** The host's count of changes made to the task here or on the page: a new count rereads. */
  readonly changes?: number;
  readonly onChanged: () => void;
  readonly onClose: () => void;
  readonly onNewTask?: () => void;
  readonly onLeaving?: (stop: (() => void) | null) => void;
}

const CONTROLS = new Set(['INPUT', 'SELECT', 'TEXTAREA']);

export function TaskPanel(props: TaskPanelProps): ReactElement {
  const { client, opening } = props;
  const { state, reload } = useRead<TaskReadResult>({
    grantKey: props.grantKey,
    run: () => client.read<TaskReadResult>('task.read', { recordId: opening.taskKey }),
    deps: [opening.taskKey, props.changes ?? 0],
    live: (signal) => client.openLive(opening.taskKey, signal),
  });
  const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    if (event.key !== 'Escape' || event.defaultPrevented) return;
    const target = event.target as HTMLElement;
    if (CONTROLS.has(target.tagName) || target.closest('[role="listbox"]') !== null) return;
    event.preventDefault();
    props.onClose();
  };
  return (
    <aside className="dtp" data-task-panel aria-label="Task panel" onKeyDown={onKeyDown}>
      <RecordState state={state} subject="task" onRetry={reload}>
        {(value) =>
          'sharedTask' in value ? (
            <p className="card__sub">
              This task is shared with you; it is changed by its business.
            </p>
          ) : (
            <PanelBody {...props} task={withPageDefaults(value.task)} />
          )
        }
      </RecordState>
    </aside>
  );
}

function PanelBody(props: TaskPanelProps & { readonly task: Task }): ReactElement {
  const { client, task } = props;
  const [perspective, setPerspective] = useState<Perspective>('team');
  const counts = perspectiveCounts({
    steps: stepMarks(task.steps),
    proposals: task.proposals ?? [],
    stagedOutput: false,
  });
  return (
    <div className="stack" data-task={task.id} data-revision={task.revision}>
      <PanelHead {...props} />
      <PanelFields
        client={client}
        grantKey={props.grantKey}
        task={task}
        onChanged={props.onChanged}
      />
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
            <PanelConversation {...props} />
            <History history={task.history} folded />
          </>
        }
        agent={<PanelAgent {...props} />}
      />
    </div>
  );
}

type SideProps = TaskPanelProps & { readonly task: Task };

/** The subtasks and time, without the doors: this is where their edits happen. */
function PanelWork(props: SideProps): ReactElement {
  const [showFinished, setShowFinished] = useState(false);
  const [showAllTime, setShowAllTime] = useState(false);
  return (
    <TeamSubtasks
      client={props.client}
      task={props.task}
      showFinished={showFinished}
      onShowFinished={setShowFinished}
      showAllTime={showAllTime}
      onShowAllTime={setShowAllTime}
      onChanged={props.onChanged}
      onOpenPanel={undefined}
      doors={false}
    />
  );
}

/** The conversation, opening on the tab the reply door was pressed from. */
function PanelConversation(props: SideProps): ReactElement {
  const { task, opening } = props;
  const [draft, setDraft] = useState<CommentDraft | null>(
    opening.tab === null
      ? null
      : { body: '', tab: opening.tab, replyTo: null, pending: null, stale: null },
  );
  const [refusal, setRefusal] = useState<string | null>(null);
  return (
    <Comments
      scope="panel"
      client={props.client}
      comments={task.comments}
      recordId={task.id}
      revision={task.revision}
      refusal={refusal}
      onRefused={setRefusal}
      onPosted={props.onChanged}
      draft={draft}
      onDraft={setDraft}
    />
  );
}

/** The Agent side: the brief, and the rest drawn not connected until the assistant is. */
function PanelAgent(props: SideProps): ReactElement {
  const { task } = props;
  return (
    <>
      <BriefField
        client={props.client}
        recordId={task.id}
        revision={task.revision}
        value={task.agentBrief}
        onSaved={props.onChanged}
      />
      <p className="card__sub" data-not-connected="agent">
        Not connected yet: the agent’s proposals, gates and runs show here once the assistant is
        connected.
      </p>
    </>
  );
}

/** The head: the task's name, its own page, a New task door not built yet, and close. */
function PanelHead(props: SideProps): ReactElement {
  const { task } = props;
  return (
    <div className="dtp__head">
      <h2 className="t-title" data-panel-title>
        <PanelName client={props.client} task={task} onChanged={props.onChanged} />
      </h2>
      <button
        className="btn"
        type="button"
        data-panel-head="new"
        disabled
        title="New task from the panel is not built yet (MP-4-13)."
      >
        New task
      </button>
      <a
        className="btn"
        data-panel-head="page"
        href={pathTo('agency:task-detail', { key: task.key })}
      >
        Open its page
      </a>
      <GoTo task={task} />
      <button className="btn" type="button" data-panel-head="close" onClick={props.onClose}>
        Close
      </button>
    </div>
  );
}

/** The head's go-to, drawn only when the task links to a page inside the product. */
function GoTo(props: { readonly task: Task }): ReactElement | null {
  const door = pageLinkDoor(props.task);
  return door === null ? null : (
    <a className="btn" data-panel-head="goto" href={door} title={door}>
      Go to its page link
    </a>
  );
}
