// SPDX-License-Identifier: AGPL-3.0-only
//
// The new-task draft's fields (MP-4-13, DN-01, DN-05): the name, due,
// estimate, tags, subtasks, time spent and a note. Each change goes straight
// to `put`, which keeps the draft for its person; nothing here writes to the
// server.

import {
  useState,
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
  type RefObject,
} from 'react';
import { ESTIMATE_CHOICES, estimateWords } from './estimates.ts';
import type { TaskDraft } from './task-draft.ts';

export interface DraftFieldsProps {
  readonly draft: TaskDraft;
  readonly put: (next: Partial<TaskDraft>) => void;
  /** The name field, focused on open and on an empty-name refusal. */
  readonly name: RefObject<HTMLInputElement | null>;
}

export function DraftFields(props: DraftFieldsProps): ReactElement {
  return (
    <div className="dtp__fields">
      <DraftFacts {...props} />
      <DraftParts {...props} />
    </div>
  );
}

function Field(props: {
  readonly id: string;
  readonly label: string;
  readonly children: ReactNode;
}): ReactElement {
  return (
    <div className="field">
      <label className="tf__k" htmlFor={props.id}>
        {props.label}
      </label>
      {props.children}
    </div>
  );
}

/** The task's own fields: the name, due and estimate go out with `task.create`. */
function DraftFacts({ draft, put, name }: DraftFieldsProps): ReactElement {
  return (
    <>
      <Field id="panel-draft-name" label="Name">
        <input
          ref={name}
          id="panel-draft-name"
          className="input"
          type="text"
          placeholder="What needs doing?"
          value={draft.title}
          onChange={(event) => {
            put({ title: event.target.value });
          }}
        />
      </Field>
      <Field id="panel-draft-due" label="Due">
        <input
          id="panel-draft-due"
          className="input"
          type="date"
          value={draft.due ?? ''}
          onChange={(event) => {
            put({ due: event.target.value === '' ? null : event.target.value });
          }}
        />
      </Field>
      <Field id="panel-draft-estimate" label="Estimate">
        <select
          id="panel-draft-estimate"
          className="input"
          value={draft.estimate === null ? '' : String(draft.estimate)}
          onChange={(event) => {
            put({ estimate: event.target.value === '' ? null : Number(event.target.value) });
          }}
        >
          <option value="">Not set</option>
          {ESTIMATE_CHOICES.map((minutes) => (
            <option key={minutes} value={minutes}>
              {estimateWords(minutes)}
            </option>
          ))}
        </select>
      </Field>
    </>
  );
}

/** What is written after the task at Create, each by its own command (DN-05). */
function DraftParts({ draft, put }: DraftFieldsProps): ReactElement {
  return (
    <>
      <ListField
        id="panel-draft-tags"
        label="Tags"
        mark="data-draft-tag"
        items={draft.tags}
        onItems={(tags) => {
          put({ tags });
        }}
      />
      <ListField
        id="panel-draft-steps"
        label="Subtasks"
        mark="data-draft-step"
        items={draft.steps}
        onItems={(steps) => {
          put({ steps });
        }}
      />
      <Field id="panel-draft-time" label="Time spent">
        <input
          id="panel-draft-time"
          className="input"
          type="text"
          placeholder="30m"
          value={draft.time}
          onChange={(event) => {
            put({ time: event.target.value });
          }}
        />
      </Field>
      <Field id="panel-draft-note" label="Note">
        <textarea
          id="panel-draft-note"
          className="input"
          value={draft.note}
          onChange={(event) => {
            put({ note: event.target.value });
          }}
        />
      </Field>
    </>
  );
}

interface ListFieldProps {
  readonly id: string;
  readonly label: string;
  readonly mark: 'data-draft-tag' | 'data-draft-step';
  readonly items: readonly string[];
  readonly onItems: (items: readonly string[]) => void;
}

/** A list the draft holds (tags, subtasks): Enter adds the typed name once, whatever its case; × removes it. */
function ListField(props: ListFieldProps): ReactElement {
  const [text, setText] = useState('');
  const add = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    const wanted = text.trim();
    setText('');
    const held = props.items.some((item) => item.toLowerCase() === wanted.toLowerCase());
    if (wanted !== '' && !held) props.onItems([...props.items, wanted]);
  };
  return (
    <Field id={props.id} label={props.label}>
      <ul className="sb__steps">
        {props.items.map((item) => (
          <ListItem key={item} {...props} item={item} />
        ))}
      </ul>
      <input
        id={props.id}
        className="input"
        type="text"
        value={text}
        onChange={(event) => {
          setText(event.target.value);
        }}
        onKeyDown={add}
      />
    </Field>
  );
}

function ListItem(props: ListFieldProps & { readonly item: string }): ReactElement {
  const { item } = props;
  return (
    <li>
      <span {...{ [props.mark]: item }}>{item}</span>
      <button
        className="btn"
        type="button"
        aria-label={`Remove ${item}`}
        onClick={() => {
          props.onItems(props.items.filter((other) => other !== item));
        }}
      >
        ×
      </button>
    </li>
  );
}
