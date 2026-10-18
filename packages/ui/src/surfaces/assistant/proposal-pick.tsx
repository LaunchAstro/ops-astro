// SPDX-License-Identifier: AGPL-3.0-only
//
// #1666: which task an edit card in a chat opened on no task applies to. The
// model never names one: the server lists the tasks the chat created, and the
// person picks. One created task is named by its title and key. More than one
// is a list to pick from, nothing chosen until the person chooses, each row
// with its key so two tasks of one title are told apart, paged `PICK_SIZE` at
// a time in the targets' order. Once the click has gone with a choice, the
// list no longer moves. Every word is text: nothing here is markup.

import { useId, type ReactElement } from 'react';
import type { AssistantPick, AssistantPickMove, AssistantPickRow } from './types.ts';

/** How many targets a page lists, and so how many rows are read at once. */
export const PICK_SIZE = 5;

/** The click may go: the person picked, or the one task is named. */
export const picked = (pick: AssistantPick | undefined): boolean =>
  pick === undefined ||
  (pick.chosen !== null &&
    (pick.required || pick.rows?.some((row) => row.id === pick.chosen) === true));

function Named(props: { readonly rows: AssistantPick['rows'] }): ReactElement {
  const row = props.rows?.[0];
  return (
    <p className="aip__plan-meta" data-proposal="target">
      {row === undefined ? (
        props.rows === null ? (
          'Reading the task…'
        ) : (
          'This task cannot be read here now.'
        )
      ) : (
        <>
          Applies to <strong>{row.title}</strong> {row.key}
        </>
      )}
    </p>
  );
}

function Row(props: {
  readonly row: AssistantPickRow;
  readonly name: string;
  readonly checked: boolean;
  readonly frozen: boolean;
  readonly onPick: ((move: AssistantPickMove) => void) | undefined;
}): ReactElement {
  const { row, onPick } = props;
  return (
    <p className="aip__plan-words">
      <label data-proposal="row">
        <input
          type="radio"
          name={props.name}
          value={row.id}
          checked={props.checked}
          disabled={props.frozen}
          data-proposal="option"
          onChange={(event) => onPick?.({ choose: event.currentTarget.value })}
        />{' '}
        <strong>{row.title}</strong> <span className="aip__plan-meta">{row.key}</span>
      </label>
    </p>
  );
}

function Pages(props: {
  readonly pick: AssistantPick;
  readonly onPick: ((move: AssistantPickMove) => void) | undefined;
}): ReactElement | null {
  const { pick, onPick } = props;
  const last = Math.ceil(pick.targets.length / PICK_SIZE) - 1;
  if (last <= 0 || pick.frozen) return null;
  const to = (page: number) => () => onPick?.({ page });
  return (
    <div className="aip__plan-act">
      {pick.page > 0 ? (
        <button
          className="btn btn--sm"
          type="button"
          data-proposal="earlier"
          onClick={to(pick.page - 1)}
        >
          Earlier
        </button>
      ) : null}
      {pick.page < last ? (
        <button
          className="btn btn--sm"
          type="button"
          data-proposal="more"
          onClick={to(pick.page + 1)}
        >
          More
        </button>
      ) : null}
    </div>
  );
}

export function ProposalPick(props: {
  readonly pick: AssistantPick;
  readonly onPick: ((move: AssistantPickMove) => void) | undefined;
}): ReactElement {
  const { pick, onPick } = props;
  const name = useId();
  if (!pick.required) return <Named rows={pick.rows} />;
  return (
    <div role="radiogroup" aria-label="Choose the task to change" data-proposal="targets">
      <p className="aip__plan-meta">Choose the task to change:</p>
      {pick.rows === null ? (
        <p className="aip__plan-meta">Reading the tasks…</p>
      ) : pick.rows.length === 0 ? (
        <p className="aip__plan-meta">None of these tasks can be read here now.</p>
      ) : (
        pick.rows.map((row) => (
          <Row
            key={row.id}
            row={row}
            name={name}
            checked={pick.chosen === row.id}
            frozen={pick.frozen}
            onPick={onPick}
          />
        ))
      )}
      <Pages pick={pick} onPick={onPick} />
    </div>
  );
}
