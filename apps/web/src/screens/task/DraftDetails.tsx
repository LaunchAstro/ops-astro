// SPDX-License-Identifier: AGPL-3.0-only
//
// The draft's client, project, stage, priority, description and agent brief
// (U112). Each change goes to `put` like every other draft field; Create writes
// the client first, through `task.set_party`, then the rest through
// `task.move`, `task.set_stage` and `task.update`.
//
// **The client is chosen here, not on the task.** The draft's own defaults
// (its category) are content once written, which locks the task's client
// (S0-5), so a task from a page with no client gets one only on its draft.
//
// **Each list is read only when wanted.** The client list is read when the
// Client select is first focused; until then a page's client is named as the
// one the draft was filed from. A draft filed from a project reads the project
// list at once, to name it; any other draft reads it on first focus. Create
// never waits on a list.
//
// **A client's project holds only that client's work.** The list offers the
// agency's own projects and the draft's client's, as `task.move` admits them,
// and choosing another client drops a project of a different one.

import { useEffect, useState, type ReactElement } from 'react';
import {
  TASK_STAGES,
  type ClientListResult,
  type TaskBoardResult,
} from '../../../../../packages/core-wire/src/index.ts';
import { isRefusal, isUnavailable, type OperationsClient } from '../../operations/client.ts';
import type { TaskDraft } from './task-draft.ts';
import { Select, type Choice } from './DraftSelect.tsx';

interface Props {
  readonly client: OperationsClient;
  readonly draft: TaskDraft;
  readonly put: (next: Partial<TaskDraft>) => void;
  readonly locked: boolean;
}

const STAGES: readonly Choice[] = TASK_STAGES.list().map((stage) => ({
  id: stage.id,
  title: stage.label,
}));
const PRIORITIES: readonly Choice[] = [1, 2, 3, 4].map((value) => ({
  id: String(value),
  title: `P${String(value)}`,
}));

export function DraftDetails(props: Props): ReactElement {
  const { draft, put } = props;
  const [askedProjects, setAskedProjects] = useState(draft.boardId !== null);
  const projects = useProjects(props.client, askedProjects);
  return (
    <>
      <DraftClient {...props} projects={projects} />
      <DraftProject
        {...props}
        projects={projects}
        onAsk={() => {
          setAskedProjects(true);
        }}
      />
      <Select
        id="panel-draft-stage"
        label="Stage"
        locked={props.locked}
        value={draft.stage}
        choices={STAGES}
        onChoose={(stage) => {
          put({ stage });
        }}
      />
      <Select
        id="panel-draft-priority"
        label="Priority"
        locked={props.locked}
        value={draft.priority === null ? null : String(draft.priority)}
        choices={PRIORITIES}
        onChoose={(value) => {
          put({ priority: value === null ? null : Number(value) });
        }}
      />
      <Words id="panel-draft-description" label="Description" {...props} field="description" />
      <Words id="panel-draft-brief" label="Agent brief" {...props} field="agentBrief" />
    </>
  );
}

function Words(
  props: Props & {
    readonly id: string;
    readonly label: string;
    readonly field: 'description' | 'agentBrief';
  },
): ReactElement {
  return (
    <div className="field">
      <label className="tf__k" htmlFor={props.id}>
        {props.label}
      </label>
      <textarea
        id={props.id}
        className="input"
        readOnly={props.locked}
        value={props.draft[props.field]}
        onChange={(event) => {
          props.put({ [props.field]: event.target.value });
        }}
      />
    </div>
  );
}

/** A project and its client: null for the agency's own, '' for one the reader cannot see. */
type Project = Choice & { readonly client: string | null };

/** The Projects board's projects, read once `asked`; null until they answer. */
function useProjects(client: OperationsClient, asked: boolean) {
  const [answer, setAnswer] = useState<readonly Project[] | 'failed' | null>(null);
  useEffect(() => {
    if (!asked) return;
    let live = true;
    void client.read<TaskBoardResult>('task.board', { board: null }).then((read) => {
      if (!live) return null;
      setAnswer(
        isRefusal(read) || isUnavailable(read)
          ? 'failed'
          : read.value.tasks.map((task) => ({
              id: task.id,
              title: task.title ?? 'Untitled',
              client: task.clientSet ? (task.client?.clientId ?? '') : null,
            })),
      );
      return null;
    });
    return () => {
      live = false;
    };
  }, [asked, client]);
  return answer;
}

type Projects = ReturnType<typeof useProjects>;

/** The business's clients, read once `asked`; null until they answer. */
function useClients(client: OperationsClient, asked: boolean) {
  const [answer, setAnswer] = useState<readonly Choice[] | 'failed' | null>(null);
  useEffect(() => {
    if (!asked) return;
    let live = true;
    void client.read<ClientListResult>('client.list', {}).then((read) => {
      if (!live) return null;
      setAnswer(
        isRefusal(read) || isUnavailable(read) || !Array.isArray(read.value.clients)
          ? 'failed'
          : read.value.clients.map((each) => ({ id: each.clientId, title: each.name })),
      );
      return null;
    });
    return () => {
      live = false;
    };
  }, [asked, client]);
  return answer;
}

/** Whether the chosen project still takes the client's work: none chosen, or the agency's own. */
function projectKept(projects: Projects, boardId: string | null): boolean {
  if (boardId === null) return true;
  return (
    Array.isArray(projects) && projects.some((one) => one.id === boardId && one.client === null)
  );
}

function DraftClient(props: Props & { readonly projects: Projects }): ReactElement {
  const chosen = props.draft.clientId;
  const [asked, setAsked] = useState(false);
  const answer = useClients(props.client, asked);
  const listed = Array.isArray(answer) ? answer : [];
  const shown =
    chosen === null || listed.some((choice) => choice.id === chosen)
      ? listed
      : [...listed, { id: chosen, title: 'The client it was filed from' }];
  return (
    <>
      <Select
        id="panel-draft-client"
        label="Client"
        none="No client"
        locked={props.locked}
        value={chosen}
        choices={shown}
        onFocus={() => {
          setAsked(true);
        }}
        onChoose={(clientId) => {
          props.put(
            projectKept(props.projects, props.draft.boardId)
              ? { clientId }
              : { clientId, boardId: null },
          );
        }}
      />
      {answer === 'failed' ? (
        <p className="card__sub">The client list could not be loaded.</p>
      ) : null}
    </>
  );
}

function DraftProject(
  props: Props & { readonly projects: Projects; readonly onAsk: () => void },
): ReactElement {
  const chosen = props.draft.boardId;
  const answer = props.projects;
  const offered = Array.isArray(answer)
    ? answer.filter((project) => project.client === null || project.client === props.draft.clientId)
    : [];
  const listed =
    chosen === null || offered.some((choice) => choice.id === chosen)
      ? offered
      : [...offered, { id: chosen, title: 'The project it was filed from' }];
  return (
    <>
      <Select
        id="panel-draft-board"
        label="Project"
        none="None"
        locked={props.locked}
        value={chosen}
        choices={listed}
        onFocus={props.onAsk}
        onChoose={(boardId) => {
          props.put({ boardId });
        }}
      />
      {answer === 'failed' ? (
        <p className="card__sub">The project list could not be loaded.</p>
      ) : null}
    </>
  );
}
