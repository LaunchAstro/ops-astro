// SPDX-License-Identifier: AGPL-3.0-only
//
// A Wayfinder map: the map view (WF-3), a map's Destination, Notes, Decisions
// so far, Not yet specified (the fog) and Out of scope, each edited in place,
// with the version history `map revised` writes; and the tickets, frontier and
// fog views (WF-4), moved between as tabs that keep the map and its filters.
//
// **One read, and each write through its owning command.** Everything drawn
// comes from `map.view` (the frontier view adds `map.frontier`, its read
// model), which answers the map's sections, decisions, versions, tickets and
// the revisions a write sends back. Every write carries its target's revision,
// so a second writer who moved it on gets `VERSION_STALE`, not a lost update. After an applied edit the page reads the map again: the new version
// in the history is the server's, never one this file numbered.
//
// **The command's state lives above the read.** A reread unmounts the loaded
// view (`RecordState` draws its loading voice), so a refusal held inside it
// would vanish together with the attempt it was about. It is held here, and
// the screen registry keys this screen by map and grant, so another map or
// another reader starts with none (a closed edit included).
//
// The look waits on the accepted prototype W4 (#603); until then the page is
// drawn with the kit's existing section and button classes.

import { useState, type ReactElement } from 'react';
import { COMMAND_SURFACE } from '../../../../packages/core-wire/src/index.ts';
import type { MapViewResult } from '../../../../packages/core-wire/src/index.ts';
import type { OperationsClient, WireRefusal } from '../operations/client.ts';
import { useRead } from '../data/use-read.ts';
import { useCommand } from '../records/use-command.ts';
import { RecordState } from '../views/record-state.tsx';
import { MapViews } from './map/Views.tsx';
import {
  NO_FILTERS,
  type Filters,
  type MapCommand,
  type MapViewName,
  type Send,
} from './map/model.ts';

export interface MapScreenProps {
  readonly client: OperationsClient;
  readonly grantKey: string;
  /** The map's key (or its identifier), as the address carries it. */
  readonly mapKey: string;
}

// Codes about who may act. A grant refusal does not name the key it looked
// for, so the page names the one the command it sent is declared with, as the
// CLI's refusal line does (`apps/cli/render.ts`).
const AUTHORITY = /GRANT|PERMIT|DELEGATION|AUTH|AGENT/u;

function needs(command: MapCommand, refusal: WireRefusal | undefined): string | null {
  const row = COMMAND_SURFACE.find((one) => one.name === command);
  return row !== undefined && refusal !== undefined && AUTHORITY.test(refusal.code)
    ? `You need ${row.collection}:${row.action} to change this map.`
    : null;
}

/** The page's writes: one at a time, each followed by a reread unless refused. */
function useWrites(client: OperationsClient, reload: () => void) {
  const command = useCommand();
  const [sent, setSent] = useState<MapCommand>('map.revise');
  const send: Send = (name, recordId, revision, body) => {
    setSent(name);
    command.run(
      () => client.mutate(name, { recordId, ...body }, { expectedRevision: revision }),
      (settlement) => {
        // Applied, or stale: either way the map on screen is no longer the
        // server's, so read it again. A refusal leaves the map as it was.
        if (settlement.kind === 'ok' || settlement.kind === 'stale') reload();
      },
    );
  };
  return { command, sent, send };
}

export function MapScreen(props: MapScreenProps): ReactElement {
  const client = props.client;
  const { state, reload } = useRead<MapViewResult>({
    grantKey: props.grantKey,
    run: () => client.read<MapViewResult>('map.view', { recordId: props.mapKey }),
    deps: [props.mapKey],
  });
  const { command, sent, send } = useWrites(client, reload);
  // Held above the read, so a reread after a write keeps the view and filters.
  const [view, setView] = useState<MapViewName>('map');
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);

  return (
    <div className="stack" data-map-refused={state.outcome === 'denied' ? '' : undefined}>
      {command.failure === null ? null : (
        <p className="field__error" role="alert" data-map-failure="">
          {command.failure.because}{' '}
          {needs(sent, 'refusal' in command.failure ? command.failure.refusal : undefined)}
        </p>
      )}
      <RecordState state={state} subject="map" onRetry={reload}>
        {(value) => (
          <MapViews
            map={value.map}
            client={client}
            grantKey={props.grantKey}
            view={view}
            onView={setView}
            filters={filters}
            onFilters={setFilters}
            busy={command.locked}
            send={send}
          />
        )}
      </RecordState>
    </div>
  );
}
