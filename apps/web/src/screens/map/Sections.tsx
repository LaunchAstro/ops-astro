// SPDX-License-Identifier: AGPL-3.0-only
//
// The map view's sections (WF-3), the first of the four views, in the order
// the scoping map names them:
// Destination, Notes, Decisions so far, Not yet specified, Out of scope, and
// the version history. The sections that only read are `ReadSections.tsx`.
// Every edit is handed up as a `map.revise` body; this file sends nothing
// itself.

import type { ReactElement } from 'react';
import { Empty } from '@launchastro/ui';
import type { MapView } from '../../../../../packages/core-wire/src/index.ts';
import { Decisions, Section, ticketLink, Versions } from './ReadSections.tsx';
import type { Drafts } from './model.ts';

/** One edit: the operands of `map.revise` beyond its target and revision, and its draft slot. */
export type Revise = (body: Readonly<Record<string, unknown>>, slot?: string) => void;

interface SectionsProps {
  readonly map: MapView;
  /** A write is in flight, or the server has closed this map's edits to the reader. */
  readonly busy: boolean;
  readonly drafts: Drafts;
  readonly onRevise: Revise;
}

export function MapSections(props: SectionsProps): ReactElement {
  const { map, busy, drafts } = props;
  const revise = props.onRevise;
  return (
    <div className="stack">
      <EditableText
        // The draft is held above the read: the editor closes when its save
        // applies, and stays open with its words on a refusal or a stale save.
        kind="destination"
        label="Destination"
        text={map.destination?.text ?? null}
        busy={busy}
        drafts={drafts}
        onSave={(text) => {
          revise({ destination: text }, 'destination');
        }}
      />
      <EditableText
        kind="notes"
        label="Notes"
        text={map.notes?.text ?? null}
        busy={busy}
        drafts={drafts}
        onSave={(text) => {
          revise({ notes: text }, 'notes');
        }}
      />
      <Decisions map={map} />
      <Fog map={map} busy={busy} drafts={drafts} onRevise={revise} />
      <OutOfScope map={map} busy={busy} drafts={drafts} onRevise={revise} />
      <Versions map={map} />
    </div>
  );
}

interface EditableProps {
  readonly kind: 'destination' | 'notes';
  readonly label: string;
  readonly text: string | null;
  readonly busy: boolean;
  readonly drafts: Drafts;
  readonly onSave: (text: string) => void;
}

function EditableText(props: EditableProps): ReactElement {
  const draft = props.drafts.text(props.kind);
  const setDraft = (text: string | null) => {
    props.drafts.setText(props.kind, text);
  };
  return (
    <Section name={props.kind} label={props.label}>
      {draft !== null && props.drafts.conflict === props.kind ? (
        <p data-map-latest="">Now saved: {props.text ?? 'nothing'}</p>
      ) : null}
      {draft === null ? (
        <>
          {props.text === null ? (
            <Empty look="inline" title="Not written yet." />
          ) : (
            <p>{props.text}</p>
          )}
          <div className="btnrow">
            <button
              className="btn"
              type="button"
              data-edit={props.kind}
              disabled={props.busy}
              onClick={() => {
                setDraft(props.text ?? '');
              }}
            >
              Edit
            </button>
          </div>
        </>
      ) : (
        <EditForm {...props} draft={draft} onDraft={setDraft} />
      )}
    </Section>
  );
}

/** The editor: the draft, Save, and Cancel, which drops the draft unsent. */
function EditForm(
  props: EditableProps & {
    readonly draft: string;
    readonly onDraft: (draft: string | null) => void;
  },
): ReactElement {
  return (
    <form
      className="field"
      onSubmit={(event) => {
        event.preventDefault();
        props.onSave(props.draft);
      }}
    >
      <textarea
        className="input"
        name={props.kind}
        aria-label={props.label}
        value={props.draft}
        onChange={(event) => {
          props.onDraft(event.target.value);
        }}
      />
      <div className="btnrow">
        <button className="btn" type="submit" data-save={props.kind} disabled={props.busy}>
          Save
        </button>
        <button
          className="btn"
          type="button"
          onClick={() => {
            props.onDraft(null);
          }}
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

function AddLine(props: {
  readonly name: string;
  readonly label: string;
  readonly busy: boolean;
  readonly drafts: Drafts;
  readonly onAdd: (text: string) => void;
}): ReactElement {
  // Held above the read under the section's name, and cleared once the add applies.
  const text = props.drafts.text(props.name) ?? '';
  const setText = (next: string) => {
    props.drafts.setText(props.name, next === '' ? null : next);
  };
  return (
    <form
      className="btnrow"
      onSubmit={(event) => {
        event.preventDefault();
        if (text.trim() === '') return;
        props.onAdd(text);
      }}
    >
      <input
        className="input"
        name={props.name}
        aria-label={props.label}
        value={text}
        onChange={(event) => {
          setText(event.target.value);
        }}
      />
      <button className="btn" type="submit" data-add={props.name} disabled={props.busy}>
        Add
      </button>
    </form>
  );
}

function Fog(props: SectionsListProps): ReactElement {
  const fog = props.map.fog;
  return (
    <Section name="fog" label="Not yet specified">
      {fog.length === 0 ? <Empty look="inline" title="Nothing is foggy." /> : null}
      <ul>
        {fog.map((patch) => (
          <li key={patch.id} data-component={patch.id}>
            {patch.text}{' '}
            <button
              className="btn"
              type="button"
              data-retire={patch.id}
              disabled={props.busy}
              onClick={() => {
                props.onRevise({ retire: [patch.id] });
              }}
            >
              Remove
            </button>
          </li>
        ))}
      </ul>
      <AddLine
        name="fog"
        label="A line not yet specified"
        busy={props.busy}
        drafts={props.drafts}
        onAdd={(text) => {
          props.onRevise({ addFog: [text] }, 'fog');
        }}
      />
    </Section>
  );
}

interface SectionsListProps {
  readonly map: MapView;
  readonly busy: boolean;
  readonly drafts: Drafts;
  readonly onRevise: Revise;
}

function OutOfScope(props: SectionsListProps): ReactElement {
  const items = props.map.outOfScope;
  const keyOf = (id: string | null) => props.map.tickets.find((t) => t.id === id)?.key ?? null;
  return (
    <Section name="out-of-scope" label="Out of scope">
      {items.length === 0 ? <Empty look="inline" title="Nothing has been ruled out." /> : null}
      <ul>
        {items.map((item) => (
          <li key={item.id} data-component={item.id}>
            {item.ticketId === null ? item.text : ticketLink(keyOf(item.ticketId), item.text)}
          </li>
        ))}
      </ul>
      <AddLine
        name="out-of-scope"
        label="A line out of scope"
        busy={props.busy}
        drafts={props.drafts}
        onAdd={(text) => {
          props.onRevise({ addOutOfScope: [{ text }] }, 'out-of-scope');
        }}
      />
    </Section>
  );
}
