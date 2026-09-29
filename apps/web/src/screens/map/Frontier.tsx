// SPDX-License-Identifier: AGPL-3.0-only
//
// The frontier and fog views (WF-4). The frontier is read from its read model
// (`map.frontier`), in its own order, only while its tab is open, so it is
// always as current as the map it sits in; the filters narrow it without
// reordering. The fog view lists the patches not yet specified and graduates
// one into tickets through `map.graduate`, which retires the patch in the same
// version.

import { useState, type ReactElement } from 'react';
import type { MapFrontierResult, MapView } from '../../../../../packages/core-wire/src/index.ts';
import type { OperationsClient } from '../../operations/client.ts';
import { useRead } from '../../data/use-read.ts';
import { RecordState } from '../../views/record-state.tsx';
import { Section, ticketLink } from './Sections.tsx';
import { TICKET_TYPES, passes, type Filters, type Send } from './model.ts';

export function FrontierView(props: {
  readonly map: MapView;
  readonly client: OperationsClient;
  readonly grantKey: string;
  readonly filters: Filters;
}): ReactElement {
  const { client, map } = props;
  const { state, reload } = useRead<MapFrontierResult>({
    grantKey: props.grantKey,
    run: () => client.read<MapFrontierResult>('map.frontier', { recordId: map.id }),
    deps: [map.id, map.revision],
  });
  return (
    <RecordState state={state} subject="frontier" onRetry={reload}>
      {(value) => {
        const shown = value.frontier.filter((ticket) => passes(props.filters, ticket));
        return (
          <Section name="frontier" label="Frontier">
            {shown.length === 0 ? <p>No ticket is ready to start.</p> : null}
            <ol>
              {shown.map((ticket) => (
                <li key={ticket.id} data-ticket={ticket.id}>
                  {ticketLink(ticket.key, `${ticket.key ?? ''} ${ticket.title ?? ''}`.trim())}{' '}
                  <span className="sbact__meta">{ticket.type}</span>
                </li>
              ))}
            </ol>
          </Section>
        );
      }}
    </RecordState>
  );
}

export function FogView(props: {
  readonly map: MapView;
  readonly busy: boolean;
  readonly send: Send;
}): ReactElement {
  const { map } = props;
  const [graduating, setGraduating] = useState<string | null>(null);
  return (
    <Section name="fog-view" label="Fog">
      {map.fog.length === 0 ? <p>Nothing on this map is foggy.</p> : null}
      <ul>
        {map.fog.map((patch) => (
          <li key={patch.id} data-patch={patch.id}>
            {patch.text}{' '}
            {graduating === patch.id ? (
              <Graduate
                onCancel={() => {
                  setGraduating(null);
                }}
                busy={props.busy}
                onGraduate={(tickets) => {
                  props.send('map.graduate', map.id, map.revision, { patchId: patch.id, tickets });
                }}
              />
            ) : (
              <button
                className="btn"
                type="button"
                data-graduate={patch.id}
                disabled={props.busy}
                onClick={() => {
                  setGraduating(patch.id);
                }}
              >
                Graduate into tickets
              </button>
            )}
          </li>
        ))}
      </ul>
    </Section>
  );
}

interface Line {
  readonly title: string;
  readonly type: string;
}

function Graduate(props: {
  readonly busy: boolean;
  readonly onGraduate: (tickets: readonly Line[]) => void;
  readonly onCancel: () => void;
}): ReactElement {
  const [lines, setLines] = useState<readonly Line[]>([{ title: '', type: 'task' }]);
  const set = (index: number, line: Line) => {
    setLines(lines.map((one, at) => (at === index ? line : one)));
  };
  return (
    <form
      className="stack"
      onSubmit={(event) => {
        event.preventDefault();
        props.onGraduate(lines.filter((line) => line.title.trim() !== ''));
      }}
    >
      {lines.map((line, index) => (
        <GraduateLine
          // oxlint-disable-next-line react/no-array-index-key -- lines have no identity but their place
          key={index}
          index={index}
          line={line}
          onLine={(next) => {
            set(index, next);
          }}
        />
      ))}
      <div className="btnrow">
        <button
          className="btn"
          type="button"
          data-add-ticket=""
          onClick={() => {
            setLines([...lines, { title: '', type: 'task' }]);
          }}
        >
          Add a ticket
        </button>
        <button className="btn" type="submit" data-graduate-save="" disabled={props.busy}>
          Graduate
        </button>
        <button className="btn" type="button" onClick={props.onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function GraduateLine(props: {
  readonly index: number;
  readonly line: Line;
  readonly onLine: (line: Line) => void;
}): ReactElement {
  const { index, line } = props;
  return (
    <div className="btnrow">
      <input
        className="input"
        name={`ticket-title-${String(index)}`}
        aria-label={`Ticket ${String(index + 1)} title`}
        value={line.title}
        onChange={(event) => {
          props.onLine({ ...line, title: event.target.value });
        }}
      />
      <select
        className="input"
        name={`ticket-type-${String(index)}`}
        aria-label={`Ticket ${String(index + 1)} type`}
        value={line.type}
        onChange={(event) => {
          props.onLine({ ...line, type: event.target.value });
        }}
      >
        {TICKET_TYPES.map((type) => (
          <option key={type} value={type}>
            {type}
          </option>
        ))}
      </select>
    </div>
  );
}
