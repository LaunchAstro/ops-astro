// SPDX-License-Identifier: AGPL-3.0-only
//
// Status, drawn the way the estate's own law requires: an outline, a number or
// a line, never a fill.
//
// The pinned mockup has no base `.spill` rule at all — the whole primitive is
// five colour declarations on `data-tone` and nothing else, which is the
// anti-fill law drawn rather than described. `.dot` is deliberately absent from
// these surfaces for the same reason: the mockup's own anti-dot note says the
// state marks are outline rings with the word beside them.

import type { ReactElement } from 'react';
import type { DrawnState } from '../state/project.ts';

export interface SpillProps {
  readonly state: DrawnState;
}

/**
 * The status word.
 *
 * `data-state-reference` is stamped alongside the tone so a reader can tell a
 * word the mockup drew from one the slice minted from one the projection did
 * not recognise and printed raw. Three different facts that look identical on a
 * screen otherwise, and the unknown-state rule is only honest if the third is
 * distinguishable.
 */
export function Spill(props: SpillProps): ReactElement {
  return (
    <span
      className="spill"
      data-tone={props.state.tone}
      data-state-reference={props.state.reference}
    >
      {props.state.word}
    </span>
  );
}

export function Mono(props: { readonly children: string }): ReactElement {
  return <span className="sbact__meta">{props.children}</span>;
}

export function Pill(props: { readonly children: string }): ReactElement {
  return <span className="u-pill">{props.children}</span>;
}

/**
 * The count badge, absence-honest at the call site.
 *
 * Zero renders nothing at all rather than a zero: a badge saying 0 is a badge
 * saying look, and the estate's own `countBadge` returns an empty string for
 * anything that is not a finite number above zero. Carried verbatim.
 */
export function CountBadge(props: {
  readonly count: number;
  readonly title: string;
}): ReactElement | null {
  if (!Number.isFinite(props.count) || props.count <= 0) return null;
  return (
    <span className="cbadge cbadge--plain" title={props.title}>
      {props.count}
    </span>
  );
}
