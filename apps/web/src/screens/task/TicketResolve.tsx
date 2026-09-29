// SPDX-License-Identifier: AGPL-3.0-only
//
// Resolving a ticket (WF-5): the answer and a one-line gist, both asked for.
// The gist is the line the map's Decisions so far shows, so it is a one-line
// field, and Resolve stays disabled until both are written.

import { useState, type ReactElement } from 'react';

export function TicketResolve(props: {
  readonly busy: boolean;
  readonly onResolve: (answer: string, gist: string) => void;
}): ReactElement {
  const [open, setOpen] = useState(false);
  const [answer, setAnswer] = useState('');
  const [gist, setGist] = useState('');
  if (!open) {
    return (
      <div className="btnrow">
        <button
          className="btn"
          type="button"
          data-resolve=""
          disabled={props.busy}
          onClick={() => {
            setOpen(true);
          }}
        >
          Resolve
        </button>
      </div>
    );
  }
  return (
    <ResolveForm
      busy={props.busy}
      answer={answer}
      gist={gist}
      onAnswer={setAnswer}
      onGist={setGist}
      onResolve={props.onResolve}
      onCancel={() => {
        setOpen(false);
      }}
    />
  );
}

function ResolveForm(props: {
  readonly busy: boolean;
  readonly answer: string;
  readonly gist: string;
  readonly onAnswer: (answer: string) => void;
  readonly onGist: (gist: string) => void;
  readonly onResolve: (answer: string, gist: string) => void;
  readonly onCancel: () => void;
}): ReactElement {
  const { answer, gist } = props;
  const ready = answer.trim() !== '' && gist.trim() !== '';
  return (
    <form
      className="field"
      onSubmit={(event) => {
        event.preventDefault();
        if (ready) props.onResolve(answer, gist);
      }}
    >
      <textarea
        className="input"
        name="answer"
        aria-label="The answer"
        value={answer}
        onChange={(event) => {
          props.onAnswer(event.target.value);
        }}
      />
      <input
        className="input"
        type="text"
        name="gist"
        aria-label="The gist, in one line"
        value={gist}
        onChange={(event) => {
          props.onGist(event.target.value);
        }}
      />
      <div className="btnrow">
        <button className="btn" type="submit" data-resolve-save="" disabled={props.busy || !ready}>
          Resolve
        </button>
        <button className="btn" type="button" onClick={props.onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
