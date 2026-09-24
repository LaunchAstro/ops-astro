// SPDX-License-Identifier: AGPL-3.0-only
//
// The task page's title and due date form.
//
// It draws what the page holds and reports each keystroke; the draft, the
// revision it began at and the save all belong to the page. The resolve bar's
// Save is associated with this form by `form="task-fields"`, so both Save
// controls arrive at the one `onSubmit`.

import type { FormEvent, ReactElement, RefObject } from 'react';

export interface DetailsFormProps {
  /** The form itself, so the page can ask it whether an edit is a legal one. */
  readonly formRef: RefObject<HTMLFormElement | null>;
  readonly busy: boolean;
  readonly title: string;
  readonly due: string;
  readonly onEdit: (next: { title?: string; due?: string }) => void;
  readonly onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}

export function DetailsForm(props: DetailsFormProps): ReactElement {
  return (
    <form
      id="task-fields"
      className="sb__sect taskform"
      ref={props.formRef}
      onSubmit={props.onSubmit}
    >
      <div className="sb__sh">
        <span className="sb__k">Details</span>
      </div>
      <div className="field">
        <label className="tf__k" htmlFor="task-title">
          Title
        </label>
        {/*
          Disabled while the save is in flight. An input that stays live
          during its own request invites the person to type something the
          response is about to throw away, and no amount of care on the
          settlement side makes that typing visible to the server.
        */}
        <input
          id="task-title"
          className="input"
          type="text"
          required
          disabled={props.busy}
          value={props.title}
          onChange={(event) => {
            props.onEdit({ title: event.target.value });
          }}
        />
      </div>
      <div className="field">
        <label className="tf__k" htmlFor="task-due">
          Due date
        </label>
        <input
          id="task-due"
          className="input"
          type="date"
          disabled={props.busy}
          value={props.due}
          onChange={(event) => {
            props.onEdit({ due: event.target.value });
          }}
        />
      </div>
      <button className="btn btn--primary" type="submit" disabled={props.busy}>
        Save changes
      </button>
    </form>
  );
}
