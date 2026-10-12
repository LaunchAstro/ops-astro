// SPDX-License-Identifier: AGPL-3.0-only
import type { ReactElement } from 'react';
import type { AssignmentCustody, AssignmentHold } from './assignment-custody.ts';

export function AssignmentRecovery(props: {
  readonly custody: AssignmentCustody;
  readonly hold: AssignmentHold;
  readonly recordId: string;
  readonly label?: string;
}): ReactElement | null {
  const { hold } = props;
  const held = hold.pending;
  if (hold.pending === null && hold.failure === null && hold.kept) return null;
  return (
    <div className="field" data-assignment-recovery>
      {props.label === undefined ? null : <p className="card__sub">Assignment for {props.label}</p>}
      {hold.failure === null ? null : (
        <p className="field__error" role="alert">
          {hold.uncertain ? 'Assignment outcome unknown. ' : ''}
          {hold.failure.because}
        </p>
      )}
      {hold.kept ? null : (
        <p role="status" className="card__sub">
          {hold.abandoned
            ? 'This change was let go, but this browser could not clear its saved copy yet.'
            : hold.pending === null
              ? 'The recovery copy could not be cleared. Retry clears that copy before another assignment.'
              : 'The recovery copy could not be kept. The original assignment stays held.'}
        </p>
      )}
      {hold.pending === null && hold.kept ? null : (
        <button
          className="btn btn--secondary"
          type="button"
          disabled={hold.busy}
          onClick={() => {
            void props.custody.retry(props.recordId);
          }}
        >
          {hold.busy ? 'Assigning…' : hold.abandoned ? 'Clear saved copy' : 'Retry assignment'}
        </button>
      )}
      {held === null ||
      !hold.uncertain ||
      (hold.failure?.kind ?? 'unknown') === 'unknown' ? null : (
        <LetGo onClick={() => props.custody.letGo(props.recordId, held.operationId)} />
      )}
    </div>
  );
}

/** Stop waiting: offered once a held assignment's retry was refused. */
function LetGo(props: { readonly onClick: () => void }): ReactElement {
  return (
    <button className="btn btn--secondary" type="button" onClick={props.onClick}>
      Stop waiting for this change
    </button>
  );
}

export function AssignmentRecoveries(props: {
  readonly custody: AssignmentCustody;
  readonly tasks: readonly {
    readonly id: string;
    readonly key: string;
    readonly title: string | null;
  }[];
}): ReactElement {
  return (
    <>
      {props.tasks.map((task) => {
        const hold = props.custody.snapshot().holds.get(task.id);
        return hold === undefined ? null : (
          <AssignmentRecovery
            key={task.id}
            custody={props.custody}
            hold={hold}
            recordId={task.id}
            label={task.title ?? task.key}
          />
        );
      })}
    </>
  );
}
