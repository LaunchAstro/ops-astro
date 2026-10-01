// SPDX-License-Identifier: AGPL-3.0-only
//
// The description and the agent brief (MP-4-7, CS-4.23, CS-4.24, DP-34,
// DP-35, TT-01, TA-10, TA-11).
//
// **Two voices under their tabs.** The description is the Team side's: what a
// person reads about the work. The brief is the Agent side's: the pre-prompt
// an agent boots on for this task. Neither is drawn on the other side.
//
// **The page reads; the dock task panel writes** (TT-06). The page draws the
// description as prose and the brief as rendered markdown with what was asked
// for under it. The two fields below are the panel's, each written whole
// through `task.update` under `task:write`, against the revision it was read
// at: leaving the field or Ctrl/Cmd+Enter saves a change, Escape puts the
// saved text back, and an emptied field clears the value rather than storing
// blank text. A refused save keeps the typing and quotes the server.
//
// **The brief is always present.** An empty brief still draws its section,
// saying none has been written, and its field, with the placeholder.
//
// **One font rule** (R60): the description is sans on every surface, the
// rendered brief too; mono is kept for the brief's own markdown field.

import { useState, type KeyboardEvent, type ReactElement } from 'react';
import type { OperationsClient } from '../../operations/client.ts';
import { submitEdit } from '../../records/submit.ts';
import { useCommand } from '../../records/use-command.ts';
import { briefFacts } from './brief-facts.ts';
import { Markdown } from './Markdown.tsx';

// Undefined too: a task read from a server that predates the brief carries no
// `agentBrief`, and that is no brief, not a page that cannot draw.
const blank = (text: string | null | undefined): boolean => (text ?? '').trim() === '';

/** The Team side's description on the page (TT-01). */
export function DescriptionSection(props: { readonly description: string | null }): ReactElement {
  return (
    <section className="sb__sect" data-writing="description">
      <div className="sb__sh">
        <span className="sb__k">Description</span>
      </div>
      {blank(props.description) ? (
        <p className="sbempty">No description on this one yet.</p>
      ) : (
        <Markdown source={props.description ?? ''} />
      )}
    </section>
  );
}

/** The Agent side's brief on the page, and what was asked for (TA-10, TA-11). */
export function BriefSection(props: { readonly brief: string | null }): ReactElement {
  const facts = briefFacts(props.brief);
  return (
    <>
      <section className="sb__sect" data-writing="brief">
        <div className="sb__sh">
          <span className="sb__k">Agent brief</span>
        </div>
        {blank(props.brief) ? (
          <p className="sbempty">No brief has been written for this task yet.</p>
        ) : (
          <Markdown source={props.brief ?? ''} />
        )}
      </section>
      {facts.length === 0 ? null : (
        <section className="sb__sect" data-writing="asked-for">
          <div className="sb__sh">
            <span className="sb__k">What was asked for</span>
            <span className="sbact__meta">read from the brief above · not a second copy</span>
          </div>
          <div className="sout__box">
            {facts.map((fact) => (
              <div key={fact.key} className="sout__row">
                <span className="tf__k">{fact.key}</span>
                <span className="tt__prose">{fact.value}</span>
              </div>
            ))}
          </div>
        </section>
      )}
    </>
  );
}

export interface TextFieldProps {
  readonly client: OperationsClient;
  readonly recordId: string;
  /** The revision the value was read at, which the save is sent against. */
  readonly revision: number;
  readonly value: string | null;
  /** Stored: the panel reads the task again. */
  readonly onSaved: () => void;
}

interface FieldShape {
  readonly key: 'description' | 'agent_brief';
  readonly label: string;
  readonly voice: 'description' | 'brief';
  readonly className: string;
  readonly rows: number;
  readonly placeholder?: string;
}

interface TextEdit {
  readonly text: string;
  readonly because: string | null;
  readonly busy: boolean;
  readonly onChange: (text: string) => void;
  readonly save: () => void;
  readonly onKey: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
}

/** One field's text, its save through `task.update`, and its keys. */
function useTextEdit(props: TextFieldProps, key: FieldShape['key']): TextEdit {
  // What the server holds as far as this field knows: the value it was read
  // with, then each text it has stored, so a save is never sent twice.
  const [saved, setSaved] = useState(props.value ?? '');
  const [text, setText] = useState(saved);
  const command = useCommand();

  const save = (): void => {
    if (text === saved || (blank(text) && blank(saved))) return;
    const sent = text;
    command.run(
      () =>
        submitEdit(props.client, {
          command: 'task.update',
          recordId: props.recordId,
          expectedRevision: props.revision,
          fields: { [key]: blank(text) ? null : text },
        }),
      (settlement) => {
        if (settlement.kind !== 'ok') return;
        setSaved(sent);
        props.onSaved();
      },
    );
  };

  const onKey = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === 'Escape') {
      setText(saved);
      command.reset();
    } else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      save();
    }
  };

  return { text, because: command.because, busy: command.busy, onChange: setText, save, onKey };
}

function TextField(props: TextFieldProps & { readonly shape: FieldShape }): ReactElement {
  const { shape } = props;
  const edit = useTextEdit(props, shape.key);
  const id = `task-${shape.voice}`;
  return (
    <div className="field">
      <label className="tf__k" htmlFor={id}>
        {shape.label}
      </label>
      <textarea
        id={id}
        className={shape.className}
        data-writing={shape.voice}
        rows={shape.rows}
        placeholder={shape.placeholder}
        disabled={edit.busy}
        value={edit.text}
        onChange={(event) => {
          edit.onChange(event.target.value);
        }}
        onBlur={edit.save}
        onKeyDown={edit.onKey}
      />
      {edit.because === null ? null : (
        <p className="field__error" role="alert" data-voice="input-wrong">
          {edit.because}
        </p>
      )}
    </div>
  );
}

const DESCRIPTION: FieldShape = {
  key: 'description',
  label: 'Description',
  voice: 'description',
  className: 'tf__ta',
  rows: 4,
};

const BRIEF: FieldShape = {
  key: 'agent_brief',
  label: 'Agent brief',
  voice: 'brief',
  className: 'tf__ta tf__ta--md',
  rows: 10,
  placeholder: 'The pre-prompt an agent boots on — write it here.',
};

/** The panel's Team-side description field (DP-35). */
export function DescriptionField(props: TextFieldProps): ReactElement {
  return <TextField {...props} shape={DESCRIPTION} />;
}

/** The panel's Agent-side brief field, always drawn, empty included (DP-34). */
export function BriefField(props: TextFieldProps): ReactElement {
  return <TextField {...props} shape={BRIEF} />;
}
