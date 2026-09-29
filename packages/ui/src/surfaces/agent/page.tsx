// SPDX-License-Identifier: AGPL-3.0-only
//
// The Agent page's sections (MP-6-2, mockup TA-01, TA-05, TA-06, TA-09): the
// run hero, the artefacts and their versions, the activity log, and what the
// run was given. Everything the agent wrote (check names and notes, artefact
// titles) is drawn as text; nothing here parses or injects markup.

import type { CSSProperties, ReactElement } from 'react';
import type { RunStory } from '../../state/agent-run.ts';
import type { ActivityRow, Artefact, HeroCell } from '../../state/agent-page.ts';
import { shortDigest, words } from './format.ts';

/** "2026-09-29 09:10", in UTC as the server stores it. */
const stamp = (at: string): string => at.slice(0, 16).replace('T', ' ');

export function Hero(props: {
  readonly story: RunStory;
  readonly cells: readonly HeroCell[];
}): ReactElement {
  const { story, cells } = props;
  const columns = { '--tph-cols': cells.length === 3 ? 3 : 2 } as CSSProperties;
  return (
    <div className="tph" data-tone={story.tone} data-agent="hero">
      <div className="tph__lead">
        <div className="tph__top">
          <span className="spill" data-tone={story.tone}>
            {story.word}
          </span>
          <span className="sbact__meta u-mono">
            {story.head.runId ?? 'not planned'} · attempt {story.attempt} · agent
          </span>
        </div>
        <p className="tph__head">{words(story.head.purpose)}</p>
      </div>
      <div className="tph__stats" style={columns}>
        {cells.map((cell) => (
          <div className="tph__stat" key={cell.key} data-hero={cell.key}>
            <span className="tph__n">{cell.figure}</span>
            <span className="tph__of">{cell.label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function ChecksLine(props: { readonly passed: number; readonly recorded: number }): ReactElement {
  return (
    <span className="sbact__meta" data-artefact-checks="">
      {props.recorded === 0
        ? 'No checks recorded on this version.'
        : `Checks passed ${String(props.passed)} of ${String(props.recorded)} recorded`}
    </span>
  );
}

function ArtefactBox(props: { readonly artefact: Artefact }): ReactElement {
  const { artefact } = props;
  const [newest] = artefact.versions;
  return (
    <div className="sout__box" data-artefact-kind={artefact.kind}>
      <div className="sout__row">
        <span className="sb__k u-mono">{artefact.kind}</span>
        <span>{artefact.title}</span>
        {newest === undefined ? null : (
          <ChecksLine passed={newest.passed} recorded={newest.recorded} />
        )}
      </div>
      {artefact.versions.map((one) => (
        <div className="sout__row" key={one.version} data-artefact-version={one.version}>
          <span className="sbact__meta u-mono">
            v{one.version}
            {one.current ? ' · current' : ''}
            {one.supersedes === null ? '' : ` · supersedes v${String(one.supersedes)}`}
          </span>
          <span className="sbact__meta u-mono u-wrap">{shortDigest(one.digest)}</span>
        </div>
      ))}
    </div>
  );
}

export function Artefacts(props: { readonly artefacts: readonly Artefact[] }): ReactElement {
  return (
    <section className="agent__part" data-agent="artefacts">
      <div className="sb__sh">
        <span className="sb__k">Artefacts and evidence</span>
      </div>
      {props.artefacts.length === 0 ? (
        <p className="sbempty">This task has not produced an artefact yet.</p>
      ) : (
        props.artefacts.map((artefact) => (
          <ArtefactBox key={`${artefact.kind}:${artefact.title}`} artefact={artefact} />
        ))
      )}
    </section>
  );
}

export function Activity(props: { readonly rows: readonly ActivityRow[] | null }): ReactElement {
  const { rows } = props;
  return (
    <section className="agent__part" data-agent="activity">
      <div className="sb__sh">
        <span className="sb__k">Operational activity</span>
        <span className="sbact__meta">append-only evidence</span>
      </div>
      {rows === null ? (
        <p className="sbempty">No run, so there is nothing operational to log yet.</p>
      ) : rows.length === 0 ? (
        <p className="sbempty">This run has recorded no steps.</p>
      ) : (
        <ol className="sbact">
          {rows.map((row) => (
            <li className="sbact__row" key={row.key} data-activity-row="">
              <span className="sbact__meta">
                {row.state} · {stamp(row.at)}
              </span>
              <span>{row.title}</span>
              {row.note === null ? null : <span className="sbact__meta">{row.note}</span>}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

/** What the run was given (TA-09). No pinned list is read yet, so it says so. */
export function Given(): ReactElement {
  return (
    <section className="agent__part" data-agent="given">
      <div className="sb__sh">
        <span className="sb__k">What the run was given</span>
      </div>
      <p className="sbempty">Nothing was pinned for this run.</p>
    </section>
  );
}
