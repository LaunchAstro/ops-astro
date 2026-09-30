// SPDX-License-Identifier: AGPL-3.0-only
//
// The map view's sections that only read (WF-3): Decisions so far, charting's
// pre-answers (WF-6) and the version history, with the section frame and the
// ticket link the other views share. Split from `Sections.tsx`, which keeps
// the sections a person edits.

import type { ReactElement, ReactNode } from 'react';
import { PaneEmpty } from '@launchastro/ui';
import type { MapPreAnswerView, MapView } from '../../../../../packages/core-wire/src/index.ts';
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

/**
 * Charting's pre-answers (WF-6), each with the one source it cites. They are
 * not decisions: a pre-answer resolves nothing, so it never joins Decisions so
 * far. A cited record the reader may not read comes back withheld and is drawn
 * as that, never by id.
 */
export function PreAnswers(props: { readonly map: MapView }): ReactElement {
  const answers = props.map.preAnswers;
  return (
    <Section name="pre-answers" label="Pre-answered">
      {answers.length === 0 ? (
        <PaneEmpty say="No question was pre-answered when the map was charted." />
      ) : (
        <ul>
          {answers.map((answer) => (
            <li
              key={answer.id}
              data-pre-answer={answer.id}
              data-source={sourceKind(answer)}
              data-veto-open={String(answer.vetoOpen)}
            >
              {answer.question} {answer.answer}
              {answer.vetoOpen ? ' (decided, veto open)' : ''} · {sourceOf(answer)}
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

function sourceKind(answer: MapPreAnswerView): 'record' | 'reference' | 'withheld' {
  if ('recordId' in answer.source) return 'record';
  return 'reference' in answer.source ? 'reference' : 'withheld';
}

function sourceOf(answer: MapPreAnswerView): ReactNode {
  const { source } = answer;
  if ('recordId' in source) return ticketLink(source.key, source.key ?? 'a recorded decision');
  return 'reference' in source ? source.reference : 'a source withheld from you';
}

export function Versions(props: { readonly map: MapView }): ReactElement {
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
