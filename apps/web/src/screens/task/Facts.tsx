// SPDX-License-Identifier: AGPL-3.0-only
//
// The task page's facts block (MP-4-2, TP-08 to TP-10), inside the band's
// frame the header ticket built (DS-TASK-11): the fact strip (DS-TASK-1,
// read-only), the calc line and the ten-field grid (TP-10, DS-COMP-26 inline
// form) in the mockup's order. Every value is `task.read`'s, and nothing here
// changes anything. No field is a sample any more, so none carries the mock
// label: the sample module's own rule was that a field a read carries leaves
// the samples, and its mock label goes with it, so the module has gone.
//
// **The marks are inert, and look it.** On this page the strip's ticks and
// the Handling chips only say what the record says: no tab stop, no handler,
// and the default cursor (the mockup's pointer on a dead mark is D-08, not
// copied). A tick is a picture of a state (`role="img"`), which takes no
// `aria-checked`: its state is in its name and `data-on`. The ticks that
// change them are the dock panel's (MP-4-10).
//
// **Whose move is derived** (DP-14): absent once the task is complete; Review
// while a gate waits on a person; Agent while an agent holds a live lease;
// Team otherwise.
//
// **A field with nothing in it reads "not set"**, and Page link "nothing
// yet". The page link (MP-4-12) reads as words here, like every mark in the
// band; the panel draws it as a door. The estimate reads as the panel's words
// (`estimateWords`), and the category by its label (`TASK_CATEGORIES`, a
// value off the list as stored). Client says only whether one is set until
// the client model names it.

import type { ReactElement } from 'react';
import { Icon } from '@launchastro/ui';
import { estimateWords } from './estimates.ts';
import {
  TASK_CATEGORIES,
  TASK_STAGES,
  type InternalTaskDetail,
} from '../../../../../packages/core-wire/src/index.ts';

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

/** A derived cell's label, with the calculation-source word after it. */
function Derived(props: { readonly label: string }): ReactElement {
  return (
    <span className="mstrip__k">
      {props.label}
      <span className="mcalc__src">derived</span>
    </span>
  );
}

/** A handling tick on the page: a picture of the record's state, not a control. */
function Mark(props: { readonly name: string; readonly label: string; readonly on: boolean }) {
  return (
    <span className="mstrip__c">
      <span className="mstrip__k">{props.label}</span>
      <span
        className="check tpr__mark"
        role="img"
        data-mark={props.name}
        data-on={props.on ? 'yes' : 'no'}
        aria-label={`${props.label}: ${props.on ? 'yes' : 'no'}`}
      >
        {props.on ? <Icon name="check" size="sm" /> : null}
      </span>
    </span>
  );
}

/** A true flag is worth a chip; neither true is worth a sentence (the mockup's rule). */
function Handling(props: { readonly task: InternalTaskDetail }): ReactElement {
  const chips = [
    ...(props.task.adHoc ? ['Ad hoc'] : []),
    ...(props.task.clientAccess ? ['Client access'] : []),
  ];
  if (chips.length === 0) return <>Neither ad hoc nor client-visible</>;
  return (
    <>
      {chips.map((chip) => (
        <span className="chip chip--outline" data-chip key={chip}>
          {chip}
        </span>
      ))}
    </>
  );
}

/**
 * DS-TASK-1, the page's read-only variant: two derived cells and two ticks
 * drawn as pictures of a state (no pointer, nothing to press).
 */
function Strip(props: { readonly task: InternalTaskDetail }): ReactElement {
  const { task } = props;
  const move = whoseMove(task);
  return (
    <div className="mstrip" role="group" aria-label="Derived task facts and handling">
      {move === null ? null : (
        <span
          className="mstrip__c"
          data-mstrip-fact="whose-move"
          data-fact="move"
          title="Worked out from the task, not set"
        >
          <Derived label="Whose move" />
          <output className="mstrip__v mstrip__bucket">{move}</output>
        </span>
      )}
      <span
        className="mstrip__c"
        data-mstrip-fact="rank"
        data-fact="rank"
        title="Worked out from the marks, not set"
      >
        <Derived label="Rank" />
        {task.rank.number === null ? (
          <output className="mstrip__v mstrip__v--none">not ranked</output>
        ) : (
          <output className="mstrip__v mstrip__rank">#{task.rank.number}</output>
        )}
      </span>
      <Mark name="adhoc" label="Ad hoc" on={task.adHoc} />
      <Mark name="client-access" label="Client access" on={task.clientAccess} />
    </div>
  );
}

function categoryOf(task: InternalTaskDetail): string | undefined {
  const category = task.category ?? null;
  return category === null ? undefined : TASK_CATEGORIES.labelOf(category);
}

function estimateOf(task: InternalTaskDetail): string | undefined {
  const minutes = task.estimateMinutes ?? null;
  return minutes === null ? undefined : estimateWords(minutes);
}

function clientWords(task: InternalTaskDetail): string {
  const summary = task.clientSummary;
  if (summary === undefined) return 'Client details unavailable';
  switch (summary.kind) {
    case 'none':
      return NOT_SET;
    case 'withheld':
      return 'A client you cannot see';
    case 'readable':
      return summary.name?.trim() || 'Client without a name';
  }
}

export function TaskFacts(props: { readonly task: InternalTaskDetail }): ReactElement {
  const { task } = props;
  const band: readonly (readonly [string, string, ReactElement | string])[] = [
    ['assignee', 'Assignee', orNotSet(task.assignee?.name)],
    ['client', 'Client', clientWords(task)],
    ['due', 'Due date', orNotSet(task.due?.slice(0, 10))],
    ['estimate', 'Estimate', orNotSet(estimateOf(task))],
    ['project', 'Project', projectOf(task)],
    ['category', 'Category', orNotSet(categoryOf(task))],
    ['stage', 'Stage', orNotSet(task.stage === null ? null : TASK_STAGES.labelOf(task.stage))],
    ['status', 'Status', orNotSet(task.state?.label)],
    ['page-link', 'Page link', task.pageLink ?? 'nothing yet'],
    ['handling', 'Handling', <Handling key="handling" task={task} />],
  ];
  return (
    <section className="tpr__facts" aria-label="Facts" data-task-facts="">
      <Strip task={task} />
      {task.rank.calc === '' ? null : (
        <p className="tpr__calc" data-calc>
          {task.rank.calc}
        </p>
      )}
      <div className="taskform">
        <dl className="tf__grid" data-band>
          {band.map(([key, label, value]) => (
            <div className="tf__row" data-field={key} key={key}>
              <dt className="tf__k">{label}</dt>
              <dd className="sb__state">{value}</dd>
            </div>
          ))}
        </dl>
      </div>
    </section>
  );
}
