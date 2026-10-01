// SPDX-License-Identifier: AGPL-3.0-only
//
// The kit's marks (MP-1-3): the small pieces that label, count, say a state or
// point somewhere. Status is colour on text, an outline or a line, never a
// fill. Anything that only explains (a tooltip) is also reachable by keyboard.

import { useId, type ReactElement, type ReactNode } from 'react';
import { Icon, type GlyphName } from '../primitives/Icon.tsx';

export type MarkTone = 'ok' | 'warn' | 'bad' | 'info' | 'idle';

/** DS-PRIM-11. Chips are pills everywhere (DR-29). */
export type ChipProps =
  | {
      readonly kind?: 'outline' | 'soft' | undefined;
      readonly tone?: MarkTone | undefined;
      readonly icon?: GlyphName | undefined;
      readonly children: ReactNode;
    }
  | {
      /** A filter in force: key, value and its remove button. */
      readonly kind: 'filter';
      readonly name: string;
      readonly value: string;
      readonly onRemove: () => void;
    }
  | {
      /** A suggestion the reader can take. */
      readonly kind: 'suggestion';
      readonly children: ReactNode;
      readonly onClick: () => void;
    };

export function Chip(props: ChipProps): ReactElement {
  if (props.kind === 'filter') {
    return (
      <span className="chip chip--filter">
        <span className="chip__key">{props.name}</span> {props.value}
        <button
          type="button"
          className="chip__x"
          aria-label={`Remove the filter ${props.name} ${props.value}`}
          onClick={props.onRemove}
        >
          <Icon name="cross-small" size="xs" />
        </button>
      </span>
    );
  }
  if (props.kind === 'suggestion') {
    return (
      <button type="button" className="chip chip--suggestion" onClick={props.onClick}>
        {props.children}
      </button>
    );
  }
  const tone = props.tone === undefined ? '' : ` is-${props.tone}`;
  return (
    <span className={`chip chip--${props.kind ?? 'outline'}${tone}`}>
      {props.icon === undefined ? null : <Icon name={props.icon} size="xs" />}
      {props.children}
    </span>
  );
}

/** DS-PRIM-13. A count of nothing draws nothing: a zero badge says "look" for no reason. */
export interface CountProps {
  readonly n: number;
  readonly look?: 'badge' | 'corner' | 'plain' | 'numeral' | 'inline' | undefined;
  /** What is being counted, for a screen reader. */
  readonly label: string;
}

export function Count(props: CountProps): ReactElement | null {
  const look = props.look ?? 'badge';
  if (props.n <= 0 && look !== 'numeral') return null;
  return (
    <span
      className={look === 'badge' ? 'cbadge' : `cbadge cbadge--${look}`}
      aria-label={`${String(props.n)} ${props.label}`}
    >
      {props.n}
    </span>
  );
}

/** DS-PRIM-14: a 2 by 11 rule before a label, or a timeline node. */
export interface StatusLineProps {
  readonly tone: MarkTone;
  readonly node?: boolean | undefined;
}

export function StatusLine(props: StatusLineProps): ReactElement {
  return (
    <span
      className={`${props.node === true ? 'snode' : 'sline'} is-${props.tone}`}
      aria-hidden="true"
    />
  );
}

/** DS-PRIM-15: the state in words, in the tone. The word is always there. */
export interface StatusMarkProps {
  readonly tone: MarkTone;
  readonly children: string;
  readonly look?: 'chip' | 'text' | 'line' | undefined;
}

export function StatusMark(props: StatusMarkProps): ReactElement {
  const look = props.look ?? 'chip';
  if (look === 'chip') return <Chip tone={props.tone}>{props.children}</Chip>;
  return (
    <span className={`smark is-${props.tone}`}>
      {look === 'line' ? <StatusLine tone={props.tone} /> : null}
      {props.children}
    </span>
  );
}

/** DS-PRIM-16. People are round, clients square (DR-34). */
export interface AvatarProps {
  readonly name: string;
  readonly kind?: 'person' | 'person-large' | 'client' | undefined;
  /** The large person card's presence: on is an accent ring, away is dashed. */
  readonly presence?: 'on' | 'away' | undefined;
  /** In a stack, the person looking at this now. */
  readonly here?: boolean | undefined;
}

const initials = (name: string): string =>
  name
    .split(/\s+/u)
    .filter((part) => part !== '')
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('');

export function Avatar(props: AvatarProps): ReactElement {
  const classes = ['av', `av--${props.kind ?? 'person'}`];
  if (props.presence !== undefined) classes.push(`is-${props.presence}`);
  if (props.here === true) classes.push('is-here');
  return (
    <span className={classes.join(' ')} role="img" aria-label={props.name} title={props.name}>
      {initials(props.name)}
    </span>
  );
}

export function AvatarStack(props: { readonly people: readonly AvatarProps[] }): ReactElement {
  return (
    <span className="avstack">
      {props.people.map((person) => (
        <Avatar key={person.name} {...person} />
      ))}
    </span>
  );
}

const DOORS = {
  page: 'arrow-small-right',
  external: 'arrow-up-right-from-square',
  agent: 'sparkles',
} as const satisfies Readonly<Record<string, GlyphName>>;

/** DS-PRIM-17's door mark: says where a link goes. A dock panel's door uses the panel's own glyph. */
export function DoorMark(props: { readonly to: keyof typeof DOORS | GlyphName }): ReactElement {
  const glyph: GlyphName =
    props.to in DOORS ? DOORS[props.to as keyof typeof DOORS] : (props.to as GlyphName);
  return (
    <span className="door">
      <Icon name={glyph} />
    </span>
  );
}

/**
 * DS-PRIM-18. The explained word takes keyboard focus, and the bubble is a real
 * element the word is described by, so the explanation reaches a screen reader.
 */
export interface TermProps {
  readonly children: ReactNode;
  readonly tip: string;
  readonly place?: 'below' | 'end' | 'down' | undefined;
}

export function Term(props: TermProps): ReactElement {
  const id = useId();
  return (
    <span className={`term term--${props.place ?? 'below'}`} tabIndex={0} aria-describedby={id}>
      {props.children}
      <span className="term__tip" role="tooltip" id={id}>
        {props.tip}
      </span>
    </span>
  );
}

/** DS-PRIM-25: the mono voice. The kind badge is DR-31's fold of DS-PRIM-12. */
export interface MarkerProps {
  readonly look: 'section' | 'key' | 'stamp' | 'kind';
  readonly children: ReactNode;
}

export function Marker(props: MarkerProps): ReactElement {
  if (props.look === 'section') return <span className="marker u-tag">{props.children}</span>;
  if (props.look === 'stamp') return <span className="stamp">{props.children}</span>;
  if (props.look === 'kind') {
    return (
      <span className="kind">
        <span className="kind__glyph" aria-hidden="true" />
        {props.children}
      </span>
    );
  }
  return <span className="keytag">{props.children}</span>;
}

/** DS-PRIM-25's index: a lead key and its value. */
export function Index(props: { readonly name: string; readonly value: ReactNode }): ReactElement {
  return (
    <span className="index">
      <span className="index__k">{props.name}</span> {props.value}
    </span>
  );
}

/** DS-PRIM-25's countdown: warning ink under an hour, and "expired" as a word. */
export function Countdown(props: { readonly minutesLeft: number }): ReactElement {
  const m = props.minutesLeft;
  if (m <= 0) return <span className="ttl is-expired">Expired</span>;
  const words = m < 60 ? `${String(m)} min left` : `${String(Math.floor(m / 60))} h left`;
  return <span className={`ttl${m < 60 ? ' is-soon' : ''}`}>{words}</span>;
}

/** DS-PRIM-26. The door link is an icon-only square that says where it goes. */
export type LinkProps =
  | {
      readonly look?: 'channel' | 'prose' | undefined;
      readonly href: string;
      readonly children: ReactNode;
      readonly door?: 'page' | 'external' | undefined;
    }
  | { readonly look: 'door'; readonly href: string; readonly label: string };

export function Link(props: LinkProps): ReactElement {
  if (props.look === 'door') {
    return (
      <a className="doorlink" href={props.href} aria-label={props.label} title={props.label}>
        <Icon name="arrow-small-right" />
      </a>
    );
  }
  const external = props.door === 'external';
  return (
    <a
      className={props.look === 'prose' ? 'plink' : 'chlink'}
      href={props.href}
      target={external ? '_blank' : undefined}
      rel={external ? 'noopener noreferrer' : undefined}
    >
      {props.children}
      {props.door === undefined ? null : <DoorMark to={props.door} />}
    </a>
  );
}

/** DS-PRIM-27. */
export function Divider(props: {
  readonly look?: 'rule' | 'section' | 'vertical' | undefined;
}): ReactElement {
  const look = props.look ?? 'rule';
  if (look === 'vertical')
    return <span className="vdiv" role="separator" aria-orientation="vertical" />;
  return <hr className={look === 'section' ? 'rule rule--section' : 'rule'} />;
}
