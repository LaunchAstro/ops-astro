// SPDX-License-Identifier: AGPL-3.0-only
//
// The frontier and fog views (WF-4). The frontier is read from its read model
// (`map.frontier`), in its own order, only while its tab is open, so it is
// always as current as the map it sits in; the filters narrow it without
// reordering. The fog view lists the patches not yet specified and graduates
// one into tickets through `map.graduate`, which retires the patch in the same
// version. The open form and its lines are held above the read (`Drafts`), so
// a graduate refused VERSION_STALE keeps them over the reread map; if the
// reread map no longer has the form's patch, the lines stay on screen to copy
// or dismiss, with no save offered against a patch that is gone.

import type { ReactElement } from 'react';
import type { MapFrontierResult, MapView } from '../../../../../packages/core-wire/src/index.ts';
import type { OperationsClient } from '../../operations/client.ts';
import { useRead } from '../../data/use-read.ts';
import { RecordState } from '../../views/record-state.tsx';
import { Section, ticketLink } from './ReadSections.tsx';
import { TICKET_TYPES, passes, type Drafts, type Filters, type Line, type Send } from './model.ts';

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

export function FogView(props: FogProps): ReactElement {
  const { map } = props;
  const { graduating, setGraduating } = props.drafts;
  const gone = graduating !== null && !map.fog.some((patch) => patch.id === graduating.patch);
  return (
    <Section name="fog-view" label="Fog">
      {gone ? (
        <GoneForm
          lines={graduating.lines}
          onDismiss={() => {
            setGraduating(null);
          }}
        />
      ) : null}
      {map.fog.length === 0 ? <p>Nothing on this map is foggy.</p> : null}
      <ul>
        {map.fog.map((patch) => (
          <PatchRow key={patch.id} {...props} patch={patch} gone={gone} />
        ))}
      </ul>
    </Section>
  );
}

interface FogProps {
  readonly map: MapView;
  readonly busy: boolean;
  readonly send: Send;
  readonly drafts: Drafts;
}

/** One patch: its text, and its graduate form when open, else the button that opens it. */
function PatchRow(
  props: FogProps & { readonly patch: MapView['fog'][number]; readonly gone: boolean },
): ReactElement {
  const { map, patch } = props;
  const { graduating, setGraduating } = props.drafts;
  return (
    <li data-patch={patch.id}>
      {patch.text}{' '}
      {graduating?.patch === patch.id ? (
        <Graduate
          lines={graduating.lines}
          onLines={(lines) => {
            setGraduating({ patch: patch.id, lines });
          }}
          onCancel={() => {
            setGraduating(null);
          }}
          busy={props.busy}
          onGraduate={(tickets) => {
            const body = { patchId: patch.id, tickets };
            props.send('map.graduate', map.id, map.revision, body, 'graduate');
          }}
        />
      ) : (
        <button
          className="btn"
          type="button"
          data-graduate={patch.id}
          // Opening another form would replace a kept one whose patch is gone.
          disabled={props.busy || props.gone}
          onClick={() => {
            setGraduating({ patch: patch.id, lines: [{ title: '', type: 'task' }] });
          }}
        >
          Graduate into tickets
        </button>
      )}
    </li>
  );
}

/**
 * A graduate form whose patch is no longer in the fog: graduated (perhaps by
 * this reader, with words typed after sending) or removed. There is no
 * patch to send it against, so it offers no save: the typed titles stay
 * here, to copy into another patch's form or a ticket, until dismissed.
 */
function GoneForm(props: {
  readonly lines: readonly Line[];
  readonly onDismiss: () => void;
}): ReactElement {
  const typed = props.lines.filter((line) => line.title.trim() !== '');
  return (
    <div className="stack" data-graduate-gone="">
      <p className="field__error">
        This patch is no longer in the fog. The titles below were not graduated from it; they are
        kept here to copy.
      </p>
      <ul>
        {typed.map((line, index) => (
          // oxlint-disable-next-line react/no-array-index-key -- lines have no identity but their place
          <li key={index}>
            {line.title} <span className="sbact__meta">{line.type}</span>
          </li>
        ))}
      </ul>
      <div className="btnrow">
        <button className="btn" type="button" data-graduate-dismiss="" onClick={props.onDismiss}>
          Dismiss
        </button>
      </div>
    </div>
  );
}

interface GraduateProps {
  readonly busy: boolean;
  readonly lines: readonly Line[];
  readonly onLines: (lines: readonly Line[]) => void;
  readonly onGraduate: (tickets: readonly Line[]) => void;
  readonly onCancel: () => void;
}

function Graduate(props: GraduateProps): ReactElement {
  const { lines, onLines: setLines } = props;
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
