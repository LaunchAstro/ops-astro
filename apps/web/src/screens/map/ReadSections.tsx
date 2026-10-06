// SPDX-License-Identifier: AGPL-3.0-only
//
// The map view's sections that only read (WF-3): Decisions so far and the
// version history, with the section frame and the ticket link the other views
// share. Split from `Sections.tsx`, which keeps the sections a person edits.

import type { ReactElement, ReactNode } from 'react';
import { Empty } from '@launchastro/ui';
import type { MapView } from '../../../../../packages/core-wire/src/index.ts';
import { pathTo } from '../../routes.ts';

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

/** A ticket's own address, or nothing for one without a key. */
export function ticketLink(key: string | null, text: string): ReactNode {
  return key === null ? text : <a href={pathTo('agency:task-detail', { key })}>{text}</a>;
}

export function Decisions(props: { readonly map: MapView }): ReactElement {
  const lines = props.map.decisions;
  return (
    <Section name="decisions" label="Decisions so far">
      {lines.length === 0 ? (
        <Empty look="inline" title="No ticket has been resolved yet." />
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

export function Versions(props: { readonly map: MapView }): ReactElement {
  const versions = props.map.versions;
  return (
    <Section name="history" label="History">
      {versions.length === 0 ? (
        <Empty look="inline" title="No version has been written yet." />
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
