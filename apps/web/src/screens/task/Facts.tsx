// SPDX-License-Identifier: AGPL-3.0-only
//
// The facts band under the task page's header (DS-TASK-11): the fact strip
// (DS-TASK-1, read-only) and the read-only field grid (TP-10, DS-COMP-26
// inline form) in the mockup's order. Assignee, due date and status are the
// task's own. Everything else has no read on batch/1 and is drawn from the
// sample values in `views/task-mock.ts`, each inside the shared mock label;
// a real field never carries it. Editing stays with the controls below.

import type { ReactElement, ReactNode } from 'react';
import { Icon, SourceRegion } from '@launchastro/ui';
import type { InternalTaskDetail } from '../../../../../packages/core-wire/src/index.ts';
import { SAMPLE_FIELDS, SAMPLE_STRIP, type SampleField } from '../../views/task-mock.ts';

type Field =
  | { readonly label: string; readonly value: string }
  | { readonly label: SampleField; readonly sample: ReactNode };

/** A field drawn from the sample values; the page link reads as the mockup's empty link. */
function sample(label: keyof typeof SAMPLE_FIELDS): Field {
  const value = SAMPLE_FIELDS[label];
  return {
    label,
    sample: label === 'Page link' ? <span className="sbact__meta">{value}</span> : value,
  };
}

export function TaskFacts(props: { readonly task: InternalTaskDetail }): ReactElement {
  const { task } = props;
  const fields: readonly Field[] = [
    { label: 'Assignee', value: task.assignee?.name ?? 'Unassigned' },
    sample('Client'),
    { label: 'Due date', value: task.due === null ? 'No date' : task.due.slice(0, 10) },
    sample('Estimate'),
    sample('Project'),
    sample('Category'),
    sample('Stage'),
    { label: 'Status', value: task.state?.label ?? 'No state' },
    sample('Page link'),
    { label: 'Handling', sample: <Handling /> },
  ];
  return (
    <div className="tpr__facts" data-task-facts="">
      <SourceRegion provenance="mock">
        <FactStrip />
      </SourceRegion>
      <div className="taskform">
        <div className="tf__grid">
          {fields.map((field) =>
            'value' in field ? (
              <Row key={field.label} label={field.label}>
                {field.value}
              </Row>
            ) : (
              <SourceRegion key={field.label} provenance="mock">
                <Row label={field.label}>{field.sample}</Row>
              </SourceRegion>
            ),
          )}
        </div>
      </div>
    </div>
  );
}

function Row(props: { readonly label: string; readonly children: ReactNode }): ReactElement {
  return (
    <div className="tf__row">
      <span className="tf__k">{props.label}</span>
      <span className="sb__state">{props.children}</span>
    </div>
  );
}

/** A true flag is worth a chip; neither true is worth a sentence (the mockup's rule). */
function Handling(): ReactElement {
  const on = [
    ...(SAMPLE_STRIP.adHoc ? ['Ad hoc'] : []),
    ...(SAMPLE_STRIP.clientAccess ? ['Client access'] : []),
  ];
  return on.length === 0 ? (
    <>Neither ad hoc nor client-visible</>
  ) : (
    <>
      {on.map((word) => (
        <span className="chip chip--outline" key={word}>
          {word}
        </span>
      ))}
    </>
  );
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

/** A handling tick on the page: a picture of a state, not a control. */
function Tick(props: { readonly label: string; readonly on: boolean }): ReactElement {
  return (
    <span className="mstrip__c">
      <span className="mstrip__k">{props.label}</span>
      <span
        className="check"
        role="img"
        aria-checked={props.on}
        aria-label={`${props.label}: ${props.on ? 'yes' : 'no'}`}
      >
        {props.on ? <Icon name="check" size="sm" /> : null}
      </span>
    </span>
  );
}

/**
 * DS-TASK-1, the page's read-only variant: two derived cells and two ticks
 * drawn as pictures of a state (no pointer, nothing to press).
 */
function FactStrip(): ReactElement {
  return (
    <div className="mstrip" role="group" aria-label="Derived task facts and handling">
      <span className="mstrip__c" data-mstrip-fact="whose-move">
        <Derived label="Whose move" />
        <span className="mstrip__v mstrip__bucket">{SAMPLE_STRIP.whoseMove}</span>
      </span>
      <span className="mstrip__c" data-mstrip-fact="rank">
        <Derived label="Rank" />
        {SAMPLE_STRIP.rank === null ? (
          <span className="mstrip__v mstrip__v--none">not ranked</span>
        ) : (
          <span className="mstrip__v mstrip__rank">#{SAMPLE_STRIP.rank}</span>
        )}
      </span>
      <Tick label="Ad hoc" on={SAMPLE_STRIP.adHoc} />
      <Tick label="Client access" on={SAMPLE_STRIP.clientAccess} />
    </div>
  );
}
