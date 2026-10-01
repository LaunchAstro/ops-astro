// SPDX-License-Identifier: AGPL-3.0-only
//
// Not connected, unavailable, fresh and sample (MP-1-6).
//
// The mockup marks a part with no real source by a pink hatch over it. The
// product says what is true instead: a panel whose source is not connected
// says so with its reason, a control whose capability is not built is drawn
// disabled with a tooltip naming it, and the pink mark is kept for one case
// only, sample data on a demo install (R56). A real client has no sample data,
// so no pink ever shows there.
//
// The freshness marker in a page header is an indicator, never a control: no
// press, no hover, no focus, and no page carries a sync button
// (`docs/design-system/research/LIVE-SYNC.md`).

import { useId, type ReactElement, type ReactNode } from 'react';
import { Button, type ButtonProps } from './controls.tsx';
import { MockRegion } from './blocks.tsx';
import { Icon } from '../primitives/Icon.tsx';

/** Where a value came from. Only `mock` is marked; `absent` is already said in words. */
export type Provenance = 'real' | 'mock' | 'absent';

/** A region whose values have one provenance. Sample data is marked; nothing else is. */
export function SourceRegion(props: {
  readonly provenance: Provenance;
  readonly children: ReactNode;
}): ReactElement {
  return props.provenance === 'mock' ? (
    <MockRegion word>{props.children}</MockRegion>
  ) : (
    <>{props.children}</>
  );
}

/** A panel whose source is not connected: the words and the reason, no hatch, no sync. */
export interface NotConnectedProps {
  /** The source, in words: "a billing source", "Google Search Console". */
  readonly source: string;
  /** Why, and what would change it. */
  readonly reason: string;
  /** The one thing to do about it, when the reader may do it (connect it on Connections). */
  readonly action?: ReactNode;
}

export function NotConnected(props: NotConnectedProps): ReactElement {
  return (
    <div className="notconn" data-voice="not-connected">
      <p className="notconn__head">
        <span className="notconn__word">Not connected</span>
        <span className="notconn__source">{props.source}</span>
      </p>
      <p className="notconn__reason">{props.reason}</p>
      {props.action === undefined ? null : <div className="notconn__action">{props.action}</div>}
    </div>
  );
}

/**
 * A control whose capability is not built yet (DR-22, PR3): disabled, with a
 * tooltip naming the feature. A disabled button cannot take focus, so the
 * wrapper does, and it is described by the tooltip, so the reason reaches a
 * keyboard and a screen reader as well as a pointer.
 */
export interface UnavailableProps {
  readonly feature: string;
  readonly label: string;
  readonly variant?: ButtonProps['variant'];
  readonly icon?: ButtonProps['icon'];
}

export function Unavailable(props: UnavailableProps): ReactElement {
  const id = useId();
  const reason = `${props.feature} is not available yet`;
  return (
    <span className="unavail term" tabIndex={0} aria-describedby={id}>
      <Button variant={props.variant} icon={props.icon} disabled reason={reason}>
        {props.label}
      </Button>
      <span className="term__tip" role="tooltip" id={id}>
        {reason}
      </span>
    </span>
  );
}

/** The five things a freshness marker can say (LIVE-SYNC.md, "What the freshness marker shows"). */
export type Freshness =
  | { readonly state: 'live'; readonly age: string }
  | { readonly state: 'catching-up'; readonly lastRead: string }
  | { readonly state: 'offline'; readonly lastRead: string }
  | {
      readonly state: 'source-behind';
      readonly source: string;
      readonly lastGood: string;
      readonly href: string;
    }
  | { readonly state: 'frozen'; readonly at: string };

const freshWords = (f: Freshness): string => {
  switch (f.state) {
    case 'live':
      return `Updated ${f.age}`;
    case 'catching-up':
      return `Reconnecting · last read ${f.lastRead}`;
    case 'offline':
      return `Offline · showing data from ${f.lastRead}`;
    case 'source-behind':
      return `${f.source} behind · last good ${f.lastGood}`;
    case 'frozen':
      return `Frozen ${f.at}`;
  }
};

/**
 * DS-PRIM-25's freshness, as the product builds it: an indicator. It is not
 * focusable and has no hover or press. A source that is behind links to its
 * row on Connections, which is a link beside the marker, not the marker.
 */
export function FreshnessMarker(props: { readonly freshness: Freshness }): ReactElement {
  const f = props.freshness;
  return (
    <span className="freshrow">
      <span className={`fresh fresh--${f.state}`} role="status">
        {f.state === 'live' ? <span className="fresh__live" aria-hidden="true" /> : null}
        {freshWords(f)}
      </span>
      {f.state === 'source-behind' ? (
        <a className="chlink" href={f.href}>
          Connections
          <Icon name="arrow-small-right" size="xs" />
        </a>
      ) : null}
    </span>
  );
}
