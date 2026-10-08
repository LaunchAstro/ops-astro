// SPDX-License-Identifier: AGPL-3.0-only
import type { KeyboardEvent, MouseEvent, ReactElement } from 'react';
import { pathTo } from '../../routes.ts';
import { Avatar, Icon } from '@launchastro/ui';
import type { StepView } from '../../../../../packages/core-wire/src/index.ts';
const archivedOn = (at: string): string =>
  new Date(at).toLocaleDateString('en-AU', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'Australia/Brisbane',
  });

/** A step waiting at its gate: decided there, so no tick here (DT-04). */
function GateStepRow(props: {
  readonly step: StepView;
  readonly onOpenTask?: ((key: string, origin?: HTMLElement) => void) | undefined;
}): ReactElement {
  const { step } = props;
  return (
    <li className="sb__step" data-step={step.id} data-done={step.done} data-gate>
      <Icon name="eye" size="sm" />
      <StepTitle step={step} onOpenTask={props.onOpenTask} />
      {step.assignee === null ? null : <Avatar name={step.assignee.name} />}
      <span className="sb__gate-note" data-step-gate>
        Waiting on a gate
      </span>
    </li>
  );
}

export function StepRow(props: {
  readonly step: StepView;
  readonly busy: boolean;
  readonly onTick: (step: StepView) => void;
  readonly onOpenTask?: ((key: string, origin?: HTMLElement) => void) | undefined;
}): ReactElement {
  const { step } = props;
  const press = (): void => {
    if (!props.busy) props.onTick(step);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLSpanElement>): void => {
    if (event.key !== ' ' && event.key !== 'Enter') return;
    event.preventDefault();
    press();
  };
  const title = step.title ?? step.key;
  if (step.archived === null && step.awaitingApproval)
    return <GateStepRow step={step} onOpenTask={props.onOpenTask} />;
  return (
    <li className="sb__step" data-step={step.id} data-done={step.done}>
      {step.archived === null ? (
        <span
          className="tpr__tick"
          role="checkbox"
          tabIndex={0}
          data-step-tick={step.id}
          aria-label={title}
          aria-checked={step.done}
          aria-disabled={props.busy}
          onClick={press}
          onKeyDown={onKeyDown}
        >
          {step.done ? '✓' : ''}
        </span>
      ) : null}
      <StepTitle step={step} onOpenTask={props.onOpenTask} />
      {step.assignee === null ? null : <Avatar name={step.assignee.name} />}
      {step.archived === null ? null : (
        <span className="card__sub" data-step-archived>
          Archived {archivedOn(step.archived.at)} · {step.archived.why}
        </span>
      )}
    </li>
  );
}

export function StepCount(props: { readonly value: string | null }): ReactElement | null {
  return props.value === null ? null : (
    <span className="sb__meta" data-step-count>
      {props.value}
    </span>
  );
}

function StepTitle(props: {
  readonly step: StepView;
  readonly onOpenTask?: ((key: string, origin?: HTMLElement) => void) | undefined;
}): ReactElement {
  const open = (event: MouseEvent<HTMLAnchorElement>): void => {
    if (
      props.onOpenTask === undefined ||
      event.button !== 0 ||
      event.ctrlKey ||
      event.metaKey ||
      event.shiftKey ||
      event.altKey
    )
      return;
    event.preventDefault();
    props.onOpenTask(props.step.key, event.currentTarget);
  };
  const key = (event: KeyboardEvent<HTMLAnchorElement>): void => {
    if (
      props.onOpenTask === undefined ||
      event.key !== 'Enter' ||
      event.ctrlKey ||
      event.metaKey ||
      event.shiftKey ||
      event.altKey
    )
      return;
    event.preventDefault();
    props.onOpenTask(props.step.key, event.currentTarget);
  };
  return (
    <a
      className="sb__step-title"
      href={pathTo('agency:task-detail', { key: props.step.key })}
      onClick={open}
      onKeyDown={key}
    >
      {props.step.title ?? props.step.key}
    </a>
  );
}
