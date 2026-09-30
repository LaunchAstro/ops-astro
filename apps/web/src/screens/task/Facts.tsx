// SPDX-License-Identifier: AGPL-3.0-only
//
// The task page's facts block (MP-4-2, TP-08 to TP-10), inside the band's
// frame the header ticket built (DS-TASK-11): the strip, the calc line and
// the ten-field band. Every value is `task.read`'s, and nothing here changes
// anything.
//
// **The marks are inert, and look it.** On this page the strip and the
// Handling chips only say what the record says: no tab stop, no role, no
// handler, and the default cursor (the mockup's pointer on a dead mark is
// D-08, not copied). The ticks that change them are the dock panel's
// (MP-4-10).
//
// **Whose move is derived** (DP-14): absent once the task is complete; Review
// while a gate waits on a person; Agent while an agent holds a live lease;
// Team otherwise.
//
// **A field with nothing in it reads "not set"**, and Page link "nothing
// yet". Estimate, Category and Page link have no value on the record yet (the
// time slice, a named board section and the page link arrive later), so they
// read that way for every task until then; Client says only whether one is
// set until the client model names it.

import type { ReactElement } from 'react';
import type { InternalTaskDetail } from '../../../../../packages/core-wire/src/index.ts';

type Move = 'Review' | 'Agent' | 'Team';

const DONE = new Set(['completed', 'cancelled']);

/** Whose move it is (DP-14), or null for a task with nothing left to move. */
export function whoseMove(task: InternalTaskDetail): Move | null {
  if (task.completedAt !== null || DONE.has(task.state?.machineCategory ?? '')) return null;
  const proposals = task.proposals ?? [];
  const gated = proposals.some((proposal) =>
    proposal.versions.some((version) => version.gate?.state === 'pending'),
  );
  if (gated) return 'Review';
  const leased = proposals.some((proposal) =>
    proposal.reservations.some((reservation) => reservation.lease?.state === 'live'),
  );
  return leased ? 'Agent' : 'Team';
}

const NOT_SET = 'not set';

const orNotSet = (value: string | null | undefined): string =>
  value === null || value === undefined || value.trim() === '' ? NOT_SET : value;

function projectOf(task: InternalTaskDetail): string {
  if (task.board === null) return NOT_SET;
  if (!task.board.readable) return 'A board you cannot open';
  return orNotSet(task.board.title);
}

function Mark(props: { readonly name: string; readonly label: string; readonly on: boolean }) {
  return (
    <span className="tpr__fact">
      <span className="tf__k">{props.label}</span>
      <span
        className="tpr__mark"
        data-mark={props.name}
        data-on={props.on ? 'yes' : 'no'}
        aria-label={`${props.label}: ${props.on ? 'yes' : 'no'}`}
      >
        {props.on ? '✓' : ''}
      </span>
    </span>
  );
}

function Handling(props: { readonly task: InternalTaskDetail }): ReactElement {
  const chips = [
    ...(props.task.adHoc ? ['Ad hoc'] : []),
    ...(props.task.clientAccess ? ['Client access'] : []),
  ];
  if (chips.length === 0) return <>Neither ad hoc nor client-visible</>;
  return (
    <>
      {chips.map((chip) => (
        <span className="tpr__chip" data-chip key={chip}>
          {chip}
        </span>
      ))}
    </>
  );
}

function Strip(props: { readonly task: InternalTaskDetail }): ReactElement {
  const { task } = props;
  const move = whoseMove(task);
  return (
    <div className="tpr__strip">
      {move === null ? null : (
        <span className="tpr__fact" data-fact="move" title="Worked out from the task, not set">
          <span className="tf__k">Whose move · derived</span>
          <output className="sb__state">{move}</output>
        </span>
      )}
      <span className="tpr__fact" data-fact="rank" title="Worked out from the marks, not set">
        <span className="tf__k">Rank · derived</span>
        <output className="sb__state">
          {task.rank.number === null ? 'not ranked' : `#${task.rank.number}`}
        </output>
      </span>
      <Mark name="adhoc" label="Ad hoc" on={task.adHoc} />
      <Mark name="client-access" label="Client access" on={task.clientAccess} />
    </div>
  );
}

export function TaskFacts(props: { readonly task: InternalTaskDetail }): ReactElement {
  const { task } = props;
  const band: readonly (readonly [string, string, ReactElement | string])[] = [
    ['assignee', 'Assignee', orNotSet(task.assignee?.name)],
    ['client', 'Client', task.clientSet ? 'On file' : NOT_SET],
    ['due', 'Due date', orNotSet(task.due?.slice(0, 10))],
    ['estimate', 'Estimate', NOT_SET],
    ['project', 'Project', projectOf(task)],
    ['category', 'Category', NOT_SET],
    ['stage', 'Stage', orNotSet(task.stage)],
    ['status', 'Status', orNotSet(task.state?.label)],
    ['page-link', 'Page link', 'nothing yet'],
    ['handling', 'Handling', <Handling key="handling" task={task} />],
  ];
  return (
    <section className="tpr__facts" aria-label="Facts">
      <Strip task={task} />
      {task.rank.calc === '' ? null : (
        <p className="tpr__calc" data-calc>
          {task.rank.calc}
        </p>
      )}
      <dl className="tpr__band" data-band>
        {band.map(([key, label, value]) => (
          <div className="tf__row" data-field={key} key={key}>
            <dt className="tf__k">{label}</dt>
            <dd className="sb__state">{value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
