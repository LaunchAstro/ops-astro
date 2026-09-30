// SPDX-License-Identifier: AGPL-3.0-only
//
// What the run staged (DA-03 to DA-06): the diff, pull request, ad change or
// preview the version built, and once shipped, what it closed against with
// Roll back drawn unavailable.

import type { ReactElement } from 'react';
import type { RunStory } from '../../state/agent-run.ts';
import {
  safeHref,
  shippedOf,
  stagedOf,
  type Shipped,
  type Staged,
} from '../../state/agent-staged.ts';

export function StagedOutput(props: { readonly story: RunStory }): ReactElement {
  const { head } = props.story;
  const staged = stagedOf(head);
  const shipped = shippedOf(head);
  return (
    <div className="sout" data-agent="staged">
      <div className="sb__sh">
        <span className="sb__k">
          {shipped === null
            ? 'Staged output'
            : shipped.rolledBackAt === null
              ? `Live · since ${shipped.at}`
              : `Was live · rolled back ${shipped.rolledBackAt}`}
        </span>
        <span className="sbact__meta">built · nothing published</span>
      </div>
      {staged === null ? (
        <p className="sout__say" data-staged="none">
          Nothing was staged for this version.
        </p>
      ) : (
        <div className="sout__box" data-staged={staged.kind}>
          <StagedKind staged={staged} />
        </div>
      )}
      {shipped === null ? (
        <p className="sout__say">Staged only. Nothing has been applied.</p>
      ) : (
        <ShippedBox shipped={shipped} />
      )}
    </div>
  );
}

function ShippedBox(props: { readonly shipped: Shipped }): ReactElement {
  const { shipped } = props;
  return (
    <div className="sout__box" data-agent="shipped">
      <div className="sout__row">
        <span className="tf__k">Closed against</span>
        <span className="sout__v">{shipped.artefact}</span>
      </div>
      <div className="sout__row">
        <span className="tf__k">Snapshot</span>
        <span className="sout__v" data-agent="snapshot">
          {shipped.snapshot}
        </span>
      </div>
      {/* DA-06: Roll back waits for an executor that can restore, and
          then raises a reversal through its own gate; it is never an undo
          in place (R78). Until then it is shown unavailable, with why. */}
      <button className="btn btn--secondary btn--sm" type="button" disabled data-agent="roll-back">
        Roll back to {shipped.snapshot}
      </button>
      <span className="sbact__meta" data-agent="roll-back-reason">
        Roll back is unavailable: this run’s executor cannot restore yet. When it can, a roll back
        is a new request with its own approval and receipt.
      </span>
    </div>
  );
}

type StagedAs<K extends Staged['kind']> = Extract<Staged, { readonly kind: K }>;

function StagedKind(props: { readonly staged: Staged }): ReactElement {
  const { staged } = props;
  switch (staged.kind) {
    case 'diff':
      return <StagedDiff staged={staged} />;
    case 'pr':
      return <StagedPullRequest staged={staged} />;
    case 'ad':
      return <StagedAds staged={staged} />;
    case 'preview':
      return <StagedPreview staged={staged} />;
  }
}

function StagedDiff({ staged }: { readonly staged: StagedAs<'diff'> }): ReactElement {
  return (
    <div className="sout__diff">
      <span className="sout__where">{staged.where}</span>
      <div className="sout__d sout__d--was">
        <span className="tf__k">Now</span>
        <span className="sout__t">{staged.was}</span>
      </div>
      <div className="sout__d sout__d--will">
        <span className="tf__k">Would become</span>
        <span className="sout__t">{staged.will}</span>
      </div>
    </div>
  );
}

function StagedPullRequest({ staged }: { readonly staged: StagedAs<'pr'> }): ReactElement {
  return (
    <div className="sout__row">
      <span className="sout__v">
        {staged.repo} #{staged.number}
      </span>
      <ArtefactLink href={staged.href} className="sout__t">
        {staged.title}
      </ArtefactLink>
      <span className="sout__meta">
        {staged.files} files <span className="sout__adds">+{staged.adds}</span>{' '}
        <span className="sout__dels">−{staged.dels}</span> · {staged.checks}
      </span>
    </div>
  );
}

function StagedAds({ staged }: { readonly staged: StagedAs<'ad'> }): ReactElement {
  return (
    <div className="sout__ads">
      <span className="sout__v">{staged.account}</span>
      {staged.groups.map((group) => (
        <div className="sout__ad" key={group.name}>
          <span className="sout__adname">
            {group.name} {group.paused ? <span className="spill">Paused</span> : null}
          </span>
          <span className="sout__band">{group.band}</span>
        </div>
      ))}
      <span className="sout__meta">{staged.spend}</span>
    </div>
  );
}

function StagedPreview({ staged }: { readonly staged: StagedAs<'preview'> }): ReactElement {
  return (
    <div className="sout__row">
      <ArtefactLink href={staged.url} className="sout__v">
        {staged.url}
      </ArtefactLink>
      <span className="sout__meta">{staged.built}</span>
      <span className="sout__t">{staged.note}</span>
    </div>
  );
}

/** The staged artefact, opened in a new tab to inspect before deciding (CS-6.3), when its address is safe to open. */
function ArtefactLink(props: {
  readonly href: string;
  readonly className: string;
  readonly children: string;
}): ReactElement {
  const href = safeHref(props.href);
  return href === null ? (
    <span className={props.className} data-agent="artefact-unlinked">
      {props.children}
    </span>
  ) : (
    <a
      className={props.className}
      href={href}
      target="_blank"
      rel="noreferrer"
      data-agent="artefact"
    >
      {props.children}
    </a>
  );
}
