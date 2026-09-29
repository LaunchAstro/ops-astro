// SPDX-License-Identifier: AGPL-3.0-only
//
// The map view's sections (WF-3), the first of the four views, in the order
// the scoping map names them:
// Destination, Notes, Decisions so far, Not yet specified, Out of scope, and
// the version history. Every edit is handed up as a `map.revise` body; this
// file sends nothing itself.

import { useState, type ReactElement, type ReactNode } from 'react';
import { PaneEmpty } from '@launchastro/ui';
import type { MapView } from '../../../../../packages/core-wire/src/index.ts';
import { pathTo } from '../../routes.ts';

/** One edit: the operands of `map.revise` beyond its target and revision. */
export type Revise = (body: Readonly<Record<string, unknown>>) => void;

interface SectionsProps {
  readonly map: MapView;
  /** A write is in flight, or the server has closed this map's edits to the reader. */
  readonly busy: boolean;
  readonly onRevise: Revise;
}

export function MapSections(props: SectionsProps): ReactElement {
  const { map, busy } = props;
  const revise = props.onRevise;
  return (
    <div className="stack">
      <EditableText
        // A new version writes a new component: the editor closes on it, and
        // stays open with its draft on a refusal.
        key={map.destination?.id ?? 'destination'}
        kind="destination"
        label="Destination"
        text={map.destination?.text ?? null}
        busy={busy}
        onSave={(text) => {
          revise({ destination: text });
        }}
      />
      <EditableText
        key={map.notes?.id ?? 'notes'}
        kind="notes"
        label="Notes"
        text={map.notes?.text ?? null}
        busy={busy}
        onSave={(text) => {
          revise({ notes: text });
        }}
      />
      <Decisions map={map} />
      <Fog map={map} busy={busy} onRevise={revise} />
      <OutOfScope map={map} busy={busy} onRevise={revise} />
      <Versions map={map} />
    </div>
  );
}

export function Section(props: {
  readonly name: string;
  readonly label: string;
  readonly children: ReactNode;
}): ReactElement {
  return (
    <section className="sb__sect" data-map-section={props.name}>
      <div className="sb__sh">
        <span className="sb__k">{props.label}</span>
      </div>
      {props.children}
    </section>
  );
}

interface EditableProps {
  readonly kind: 'destination' | 'notes';
  readonly label: string;
  readonly text: string | null;
  readonly busy: boolean;
  readonly onSave: (text: string) => void;
}

function EditableText(props: EditableProps): ReactElement {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <Section name={props.kind} label={props.label}>
      {draft === null ? (
        <>
          {props.text === null ? <PaneEmpty say="Not written yet." /> : <p>{props.text}</p>}
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

/** A ticket's own address, or nothing for one without a key. */
export function ticketLink(key: string | null, text: string): ReactNode {
  return key === null ? text : <a href={pathTo('agency:task-detail', { key })}>{text}</a>;
}

function Decisions(props: { readonly map: MapView }): ReactElement {
  const lines = props.map.decisions;
  return (
    <Section name="decisions" label="Decisions so far">
      {lines.length === 0 ? (
        <PaneEmpty say="No ticket has been resolved yet." />
      ) : (
        <ol>
          {lines.map((line) => (
            <li key={line.ticketId} data-ticket={line.ticketId}>
              {ticketLink(line.key, line.gist ?? line.title ?? line.ticketId)}
            </li>
          ))}
        </ol>
      )}
    </Section>
  );
}

function AddLine(props: {
  readonly name: string;
  readonly label: string;
  readonly busy: boolean;
  readonly onAdd: (text: string) => void;
}): ReactElement {
  const [text, setText] = useState('');
  return (
    <form
      className="btnrow"
      onSubmit={(event) => {
        event.preventDefault();
        if (text.trim() === '') return;
        props.onAdd(text);
        setText('');
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
      {fog.length === 0 ? <PaneEmpty say="Nothing is foggy." /> : null}
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
        onAdd={(text) => {
          props.onRevise({ addFog: [text] });
        }}
      />
    </Section>
  );
}

interface SectionsListProps {
  readonly map: MapView;
  readonly busy: boolean;
  readonly onRevise: (body: Readonly<Record<string, unknown>>) => void;
}

function OutOfScope(props: SectionsListProps): ReactElement {
  const items = props.map.outOfScope;
  const keyOf = (id: string | null) => props.map.tickets.find((t) => t.id === id)?.key ?? null;
  return (
    <Section name="out-of-scope" label="Out of scope">
      {items.length === 0 ? <PaneEmpty say="Nothing has been ruled out." /> : null}
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
        onAdd={(text) => {
          props.onRevise({ addOutOfScope: [{ text }] });
        }}
      />
    </Section>
  );
}

function Versions(props: { readonly map: MapView }): ReactElement {
  const versions = props.map.versions;
  return (
    <Section name="history" label="History">
      {versions.length === 0 ? (
        <PaneEmpty say="No version has been written yet." />
      ) : (
        <ol className="sbact">
          {versions.toReversed().map((entry) => (
            <li className="sbact__row" key={entry.version} data-version={entry.version}>
              <span className="sb__state">Version {entry.version}</span>
              <span className="sbact__meta">
                {entry.at} · {entry.actorId} · {entry.changed.length} changed
              </span>
            </li>
          ))}
        </ol>
      )}
    </Section>
  );
}
