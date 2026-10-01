// SPDX-License-Identifier: AGPL-3.0-only
//
// The operational log (MP-6-2, TA-06, "append-only evidence"): every event
// the task's runs recorded, as `task.execution` returns them, one row each in
// the record's own order (`position`). A row names the bound plan's job its run
// was proposed under (AW-04's plan record, through AW-06's graph: `JOB-01` is
// the plan's first step), the event in words and its time, and the job's title.
// A run under no step of the plan is logged as outside it.
//
// Rows are keyed by the event, drawn from the event alone and the plan the
// read bound, so a later read only adds rows after the drawn ones: nothing in
// a row depends on what happened after it. Every word is drawn as text.

import type { ReactElement } from 'react';
import { Empty } from '../../primitives/Absence.tsx';
import { words } from './format.ts';

/** A step of the bound plan with the runs proposed under it (`task.execution`'s graph). */
export interface ActivityStep {
  readonly key: string;
  readonly title: string;
  readonly runIds: readonly string[];
}

/** One durable event (`task.execution`'s `events`). */
export interface ActivityEvent {
  readonly eventId: string;
  readonly runId: string;
  readonly position: number;
  readonly kind: string;
  readonly at: string;
}

/** What the log draws: the bound plan's steps (none when unbound) and the events. */
export interface RunActivity {
  readonly steps: readonly ActivityStep[];
  readonly events: readonly ActivityEvent[];
}

const jobLabel = (index: number): string => `JOB-${String(index + 1).padStart(2, '0')}`;

/** `2026-09-30 10:00`, in UTC, as the record keeps it. */
const minuteOf = (at: string): string => at.slice(0, 16).replace('T', ' ');

export function Activity(props: {
  readonly activity: RunActivity;
  readonly hasRun: boolean;
}): ReactElement {
  const { steps, events } = props.activity;
  const ordered = events.toSorted((left, right) => left.position - right.position);
  return (
    <section data-agent="log">
      <div className="sb__sh">
        <span className="sb__k">Operational activity</span>
        <span className="sbact__meta">append-only evidence</span>
      </div>
      {props.hasRun ? null : (
        <Empty look="inline" title="No run, so there is nothing operational to log yet." />
      )}
      {props.hasRun && ordered.length === 0 ? (
        <Empty look="inline" title="This run has recorded no steps." />
      ) : null}
      {props.hasRun && ordered.length > 0 ? (
        <div>
          {ordered.map((each) => {
            const index = steps.findIndex((step) => step.runIds.includes(each.runId));
            return <Row event={each} index={index} step={steps[index]} key={each.eventId} />;
          })}
        </div>
      ) : null}
    </section>
  );
}

function Row(props: {
  readonly event: ActivityEvent;
  readonly index: number;
  readonly step: ActivityStep | undefined;
}): ReactElement {
  const { event, step } = props;
  return (
    <div className="sbact__row" data-log="row" data-log-event={event.eventId}>
      <span className="sbact__meta u-mono">
        <span data-log="job">
          {step === undefined ? 'Outside the plan' : jobLabel(props.index)}
        </span>
        {` · ${words(event.kind)} · ${minuteOf(event.at)}`}
      </span>
      {step === undefined ? null : <span data-log="title">{step.title}</span>}
    </div>
  );
}
