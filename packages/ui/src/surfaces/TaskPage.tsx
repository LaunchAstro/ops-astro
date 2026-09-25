// SPDX-License-Identifier: AGPL-3.0-only
//
// S2 and S3: the task page's shared header, and its Team tab.
//
// **THE TITLE IS A FIELD ON THE RECORD AND THIS PAGE NEVER CARRIES A SECOND
// COPY OF IT.** The pinned page writes its own heading from the resolver for
// exactly that reason, and the rule survives the port: the header takes the
// record and the shell takes the same string, so there is one source.
//
// The audience distinction in the conversation is the part T1-R4 turns on: a
// team comment is invisible in a client projection and a client comment is
// visible in both. The mockup draws it as a class on the row plus a literal
// "team only" badge, and both are carried, because the badge is what a person
// reads and the class is what a projection filters on.

import type { ReactElement } from 'react';
import { PaneEmpty } from '../primitives/Absence.tsx';
import { CountBadge, Spill } from '../primitives/Status.tsx';
import { TabPanel, TabStrip, type TabDescriptor } from '../primitives/Tabs.tsx';
import type { DrawnState } from '../state/project.ts';

export interface TaskField {
  readonly label: string;
  readonly value: string | null;
}

export interface TaskRecord {
  readonly id: string;
  readonly name: string;
  readonly board: string | null;
  readonly category: string | null;
  readonly client: string | null;
  readonly state: DrawnState;
  /** The line under the title: where the run is, or that there is no run. */
  readonly runLine: string;
  readonly fields: readonly TaskField[];
}

export function TaskHeader(props: { readonly task: TaskRecord }): ReactElement {
  const task = props.task;
  return (
    <header className="tpr">
      <div className="tpr__crumb">
        <a className="sb__addr" href="/projects/" title="Every project, across the book">
          Projects
        </a>
        <span aria-hidden="true">›</span>
        <span>{task.board ?? 'No board'}</span>
        <span aria-hidden="true">›</span>
        <span>{task.category ?? 'uncategorised'}</span>
        <span className="sbact__meta">· {task.id}</span>
        <Spill state={task.state} />
      </div>
      <h2 className="tpr__title">{task.name}</h2>
      <div className="card__sub">
        {task.client ?? 'No client'} · {task.runLine}
      </div>
      <div className="tpr__facts">
        <div className="taskform">
          <div className="tf__grid">
            {task.fields.map((field) => (
              <div className="tf__row" key={field.label}>
                <span className="tf__k">{field.label}</span>
                {/* "not set" rather than an empty cell: an empty cell is
                    indistinguishable from a cell that failed to read. */}
                <span className="sb__state">{field.value ?? 'not set'}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </header>
  );
}

export type CommentAudience = 'team' | 'client';

export interface Comment {
  readonly id: string;
  readonly audience: CommentAudience;
  readonly author: string;
  readonly at: string;
  readonly body: string;
}

export interface HistoryEntry {
  readonly id: string;
  readonly at: string;
  /** The actor, always. A change with no actor is a change nobody made. */
  readonly who: string;
  readonly say: string;
}

export interface Subtask {
  readonly id: string;
  readonly title: string;
  readonly done: boolean;
}

export interface TeamTabProps {
  readonly description: string | null;
  readonly subtasks: readonly Subtask[];
  readonly comments: readonly Comment[];
  readonly history: readonly HistoryEntry[];
  readonly conversation: CommentAudience | 'activity';
  readonly onConversation: (tab: string) => void;
}

export function TeamTab(props: TeamTabProps): ReactElement {
  const team = props.comments.filter((comment) => comment.audience === 'team');
  const client = props.comments.filter((comment) => comment.audience === 'client');
  const tabs: readonly TabDescriptor[] = [
    { id: 'team', label: 'Internal', badge: <CountBadge count={team.length} title="Internal" /> },
    { id: 'client', label: 'Client', badge: <CountBadge count={client.length} title="Client" /> },
    { id: 'activity', label: 'All activity' },
  ];
  const done = props.subtasks.filter((subtask) => subtask.done).length;
  return (
    <div className="stack">
      <section className="sb__sect">
        <div className="sb__sh">
          <span className="sb__k">Description</span>
        </div>
        {props.description === null ? (
          <PaneEmpty say="No description on this one yet." />
        ) : (
          <p className="card__body">{props.description}</p>
        )}
      </section>

      <section className="sb__sect">
        <div className="sb__sh">
          <span className="sb__k">Subtasks</span>
          <span className="sb__meta">
            {done} of {props.subtasks.length} done
          </span>
        </div>
        {props.subtasks.length === 0 ? (
          <PaneEmpty say="No subtasks on this one yet." />
        ) : (
          <div className="sbtasks">
            {props.subtasks.map((subtask) => (
              <div className="sbtask" key={subtask.id}>
                <span className="sbbox" role="img" aria-label={subtask.done ? 'Done' : 'Not done'}>
                  {subtask.done ? '✓' : ''}
                </span>
                <span className="sbtask__t">{subtask.title}</span>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="sb__sect">
        <div className="sb__sh">
          <span className="sb__k">Conversation</span>
        </div>
        <TabStrip
          name="conversation"
          label="Conversation and activity"
          tabs={tabs}
          selected={props.conversation}
          onSelect={props.onConversation}
        />
        <TabPanel name="conversation" tab="team" selected={props.conversation}>
          <Thread comments={team} empty="No team notes on this task yet." />
        </TabPanel>
        <TabPanel name="conversation" tab="client" selected={props.conversation}>
          <Thread comments={client} empty="No client messages on this task yet." />
        </TabPanel>
        <TabPanel name="conversation" tab="activity" selected={props.conversation}>
          {props.history.length === 0 ? (
            <PaneEmpty say="Nothing logged on this task yet." />
          ) : (
            <div className="sbact">
              {props.history.map((entry) => (
                <div className="sbact__row" key={entry.id}>
                  <span className="sbact__meta">
                    {entry.at} · {entry.who}
                  </span>
                  <span className="sb__state">{entry.say}</span>
                </div>
              ))}
            </div>
          )}
        </TabPanel>
      </section>

      <section className="sb__sect">
        <div className="sb__sh">
          <span className="sb__k">History</span>
        </div>
        {props.history.length === 0 ? (
          <PaneEmpty say="Nothing has changed on this one yet." />
        ) : (
          <div className="sbact">
            {props.history.map((entry) => (
              <div className="sbact__row" key={`h-${entry.id}`}>
                <span className="sbact__meta">
                  {entry.at} · {entry.who}
                </span>
                <span className="sb__state">{entry.say}</span>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

/**
 * One audience's thread.
 *
 * `data-audience` on the row is what a projection filters on, and the "team
 * only" badge is what a person reads. Both, because a rule held only in a class
 * name is a rule nobody in the room can see.
 */
function Thread(props: {
  readonly comments: readonly Comment[];
  readonly empty: string;
}): ReactElement {
  if (props.comments.length === 0) return <PaneEmpty say={props.empty} />;
  return (
    <div className="thread">
      {props.comments.map((comment) => (
        <div
          className={`msg msg--${comment.audience}`}
          data-audience={comment.audience}
          key={comment.id}
        >
          <div className="msg__meta">
            <b>{comment.author}</b>
            <span className="msg__at">{comment.at}</span>
            {comment.audience === 'team' ? <span className="sbint">team only</span> : null}
          </div>
          <p className="msg__text">{comment.body}</p>
        </div>
      ))}
    </div>
  );
}
