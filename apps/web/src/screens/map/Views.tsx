// SPDX-License-Identifier: AGPL-3.0-only
//
// The four views of a map (WF-4): Map, Tickets, Frontier and Fog, as tabs.
// The view and the filters are held by the screen above the read, so moving
// between the views, and the reread after a write, keep both. Moving is
// navigation, which is exempt from agent parity (CS-15.18); the writes are
// `map.revise`, `map.graduate` and `task.set_blocking`, each sent by the
// screen with its target's revision.

import type { ReactElement } from 'react';
import { TabPanel, TabStrip } from '@launchastro/ui';
import type { MapView } from '../../../../../packages/core-wire/src/index.ts';
import type { OperationsClient } from '../../operations/client.ts';
import { MapSections } from './Sections.tsx';
import { TicketsView } from './Tickets.tsx';
import { FogView, FrontierView } from './Frontier.tsx';
import { TICKET_TYPES, type Filters, type MapViewName, type Send } from './model.ts';

const TABS = [
  { id: 'map', label: 'Map' },
  { id: 'tickets', label: 'Tickets' },
  { id: 'frontier', label: 'Frontier' },
  { id: 'fog', label: 'Fog' },
] as const;

export interface MapViewsProps {
  readonly map: MapView;
  readonly client: OperationsClient;
  readonly grantKey: string;
  readonly view: MapViewName;
  readonly onView: (view: MapViewName) => void;
  readonly filters: Filters;
  readonly onFilters: (filters: Filters) => void;
  readonly busy: boolean;
  readonly send: Send;
}

export function MapViews(props: MapViewsProps): ReactElement {
  const { map, view } = props;
  const panel = (tab: MapViewName, body: () => ReactElement): ReactElement => (
    <TabPanel name="map" tab={tab} selected={view}>
      {view === tab ? body() : null}
    </TabPanel>
  );
  return (
    <div className="stack" data-map={map.id} data-revision={map.revision}>
      <h1 className="task__title">{map.title ?? map.key ?? 'Map'}</h1>
      <TabStrip
        name="map"
        label="Map views"
        tabs={TABS}
        selected={view}
        onSelect={(id) => {
          props.onView(id as MapViewName);
        }}
      />
      <FilterBar filters={props.filters} onFilters={props.onFilters} />
      {panel('map', () => (
        <MapSections
          map={map}
          busy={props.busy}
          onRevise={(body) => {
            props.send('map.revise', map.id, map.revision, body);
          }}
        />
      ))}
      {panel('tickets', () => (
        <TicketsView map={map} filters={props.filters} busy={props.busy} send={props.send} />
      ))}
      {panel('frontier', () => (
        <FrontierView
          map={map}
          client={props.client}
          grantKey={props.grantKey}
          filters={props.filters}
        />
      ))}
      {panel('fog', () => (
        <FogView map={map} busy={props.busy} send={props.send} />
      ))}
    </div>
  );
}

function FilterBar(props: {
  readonly filters: Filters;
  readonly onFilters: (filters: Filters) => void;
}): ReactElement {
  const { filters } = props;
  return (
    <div className="btnrow" data-map-filters="">
      <select
        className="input"
        name="filter-type"
        aria-label="Ticket type"
        value={filters.type}
        onChange={(event) => {
          props.onFilters({ ...filters, type: event.target.value });
        }}
      >
        <option value="">Every type</option>
        {TICKET_TYPES.map((type) => (
          <option key={type} value={type}>
            {type}
          </option>
        ))}
      </select>
      <input
        className="input"
        name="filter-text"
        aria-label="Key or title contains"
        value={filters.text}
        onChange={(event) => {
          props.onFilters({ ...filters, text: event.target.value });
        }}
      />
    </div>
  );
}
