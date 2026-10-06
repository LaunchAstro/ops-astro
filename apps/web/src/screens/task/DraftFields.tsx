// SPDX-License-Identifier: AGPL-3.0-only
//
// The new-task draft's fields (MP-4-13, DN-01, DN-02, DN-05): the name, due,
// estimate, category, the owner the page named, tags, subtasks, time spent and a note. Each change goes straight
// to `put`, which keeps the draft for its person; nothing here writes to the
// server. While Create is out every field is read-only, so the draft its
// answer settles is the one it sent.

import {
  useState,
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
  type RefObject,
} from 'react';
import { TASK_CATEGORIES } from '../../../../../packages/core-wire/src/index.ts';
import { DraftTime } from './DraftTimer.tsx';
import { ESTIMATE_CHOICES, estimateWords } from './estimates.ts';
import type { TaskDraft } from './task-draft.ts';

export interface DraftFieldsProps {
  readonly draft: TaskDraft;
  readonly put: (next: Partial<TaskDraft>) => void;
  /** The name field, focused on open and on an empty-name refusal. */
  readonly name: RefObject<HTMLInputElement | null>;
  /** Create is out: nothing is edited until it answers. */
  readonly locked: boolean;
}

export function DraftFields(props: DraftFieldsProps): ReactElement {
  return (
    <div className="dtp__fields">
      <DraftFacts {...props} />
      <DraftGuesses {...props} />
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
function DraftFacts({ draft, put, name, locked }: DraftFieldsProps): ReactElement {
  return (
    <>
      <Field id="panel-draft-name" label="Name">
        <input
          ref={name}
          id="panel-draft-name"
          className="input"
          type="text"
          placeholder="What needs doing?"
          readOnly={locked}
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
          readOnly={locked}
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
          disabled={locked}
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

/** The category and the owner, written after the task at Create; the owner only as the page named it. */
function DraftGuesses({ draft, put, locked }: Omit<DraftFieldsProps, 'name'>): ReactElement {
  return (
    <>
      <Field id="panel-draft-category" label="Category">
        <select
          id="panel-draft-category"
          className="input"
          disabled={locked}
          value={draft.category ?? ''}
          onChange={(event) => {
            put({ category: event.target.value === '' ? null : event.target.value });
          }}
        >
          <option value="">Not set</option>
          {TASK_CATEGORIES.list().map((category) => (
            <option key={category.id} value={category.id}>
              {category.label}
            </option>
          ))}
        </select>
      </Field>
      {draft.owner === null ? null : (
        <p className="card__sub" data-draft-owner>
          Owner: {draft.owner.name}{' '}
          <button
            className="btn"
            type="button"
            data-draft="clear-owner"
            disabled={locked}
            onClick={() => {
              put({ owner: null });
            }}
          >
            Clear
          </button>
        </p>
      )}
    </>
  );
}

/** What is written after the task at Create, each by its own command (DN-05). */
function DraftParts({ draft, put, locked }: DraftFieldsProps): ReactElement {
  return (
    <>
      <ListField
        id="panel-draft-tags"
        label="Tags"
        mark="data-draft-tag"
        items={draft.tags}
        locked={locked}
        onItems={(tags) => {
          put({ tags });
        }}
      />
      <ListField
        id="panel-draft-steps"
        label="Subtasks"
        mark="data-draft-step"
        items={draft.steps}
        locked={locked}
        onItems={(steps) => {
          put({ steps });
        }}
      />
      <DraftTime draft={draft} put={put} locked={locked} />
      <Field id="panel-draft-note" label="Note">
        <textarea
          id="panel-draft-note"
          className="input"
          readOnly={locked}
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
  readonly locked: boolean;
}

/** A list the draft holds (tags, subtasks): Enter adds the typed name once, whatever its case; × removes it. */
function ListField(props: ListFieldProps): ReactElement {
  const [text, setText] = useState('');
  const add = (event: KeyboardEvent<HTMLInputElement>): void => {
    // An Enter that ends an input method's composition is the composition's.
    if (event.key !== 'Enter' || event.nativeEvent.isComposing) return;
    event.preventDefault();
    if (props.locked) return;
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
        readOnly={props.locked}
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
        disabled={props.locked}
        onClick={() => {
          props.onItems(props.items.filter((other) => other !== item));
        }}
      >
        ×
      </button>
    </li>
  );
}

/** A task created with parts refused after it: named, and a door to the task (never a second create). */
export function Missed(props: {
  readonly taskKey: string;
  readonly parts: readonly string[];
  readonly onOpen: (key: string) => void;
}): ReactElement {
  return (
    <>
      <p className="card__sub" role="status" data-draft-missed>
        Created {props.taskKey}; not added: {props.parts.join(', ')}. Add them on the task.
      </p>
      <button
        className="btn btn--primary"
        type="button"
        data-draft="open-created"
        onClick={() => {
          props.onOpen(props.taskKey);
        }}
      >
        Open the task
      </button>
    </>
  );
}
