// SPDX-License-Identifier: AGPL-3.0-only
//
// The kit's controls (MP-1-3): the catalogue's interactive primitives, each
// built once from `docs/design-system/catalogue/PRIMITIVES.md`.
//
// Every control here is a real element with its real role: a button is a
// `<button>`, a checkbox says `aria-checked`, the select is a button that owns a
// listbox. Focus is the one global ring (DR-1); nothing here draws its own.
// A control whose capability is not built yet is passed `disabled` with a
// `reason`, which becomes its tooltip (TICKET-PLAN R56, DR-22); it is never
// drawn live and dead.
//
// The buttons live here; the fields and the select, and the toggles, live
// beside this file, and this module exports them all.

import { type ReactElement, type ReactNode } from 'react';
import { Icon, type GlyphName } from '../primitives/Icon.tsx';

/** DS-PRIM-1. */
export interface ButtonProps {
  readonly children: ReactNode;
  readonly variant?: 'primary' | 'secondary' | 'ghost' | 'text' | undefined;
  /** `sm` is the house default; `md` pairs with a 38 input; `lg` is the portal call to action. */
  readonly size?: 'sm' | 'md' | 'lg' | undefined;
  readonly icon?: GlyphName | undefined;
  /** A toggle button (the filter preset): pressed draws the ink fill. */
  readonly pressed?: boolean | undefined;
  /** DS-PRIM-29's busy button: the label is swapped for this and the button is held. */
  readonly busy?: string | undefined;
  readonly disabled?: boolean | undefined;
  /** Why it is disabled, when the capability is not built yet. Shown as its tooltip. */
  readonly reason?: string | undefined;
  readonly type?: 'button' | 'submit' | undefined;
  readonly onClick?: (() => void) | undefined;
}

export function Button(props: ButtonProps): ReactElement {
  const busy = props.busy !== undefined;
  return (
    <button
      type={props.type ?? 'button'}
      className={`btn btn--${props.variant ?? 'secondary'} btn--${props.size ?? 'sm'}`}
      aria-pressed={props.pressed}
      aria-busy={busy ? true : undefined}
      disabled={busy || props.disabled === true}
      title={props.disabled === true ? props.reason : undefined}
      onClick={props.onClick}
    >
      {props.icon === undefined ? null : <Icon name={props.icon} size="sm" />}
      {busy ? props.busy : props.children}
    </button>
  );
}

/** DS-PRIM-2. The accessible name is required: the glyph says nothing to a screen reader. */
export interface IconButtonProps {
  readonly icon: GlyphName;
  readonly label: string;
  /** Default 26 square; compact 22 for dense rows (DR-23). */
  readonly size?: 'default' | 'compact' | undefined;
  /** `accent` is "the agent asks" (WIRING §90); `danger` is remove. */
  readonly tone?: 'accent' | 'danger' | undefined;
  /** Hidden until its row is hovered, above 900 only (DR-24). */
  readonly reveal?: boolean | undefined;
  readonly expanded?: boolean | undefined;
  readonly disabled?: boolean | undefined;
  readonly reason?: string | undefined;
  readonly onClick?: (() => void) | undefined;
}

export function IconButton(props: IconButtonProps): ReactElement {
  const classes = ['ibtn'];
  if (props.size === 'compact') classes.push('ibtn--compact');
  if (props.tone !== undefined) classes.push(`ibtn--${props.tone}`);
  if (props.reveal === true) classes.push('ibtn--reveal');
  return (
    <button
      type="button"
      className={classes.join(' ')}
      aria-label={props.label}
      aria-expanded={props.expanded}
      title={props.disabled === true && props.reason !== undefined ? props.reason : props.label}
      disabled={props.disabled}
      onClick={props.onClick}
    >
      <Icon name={props.icon} />
    </button>
  );
}

const HEAD_BUTTONS = {
  close: { icon: 'cross-small', label: 'Close' },
  back: { icon: 'angle-small-left', label: 'Back' },
  forward: { icon: 'angle-small-right', label: 'Forward' },
  new: { icon: 'plus', label: 'New' },
  'close-all': { icon: 'angle-double-right', label: 'Close all panels' },
} as const satisfies Readonly<Record<string, { icon: GlyphName; label: string }>>;

/** The dock panel head's buttons (DOCK D-26): one component, built on DS-PRIM-2. */
export interface HeadButtonProps {
  readonly kind: keyof typeof HEAD_BUTTONS;
  /** Overrides the default name, for example "New task". */
  readonly label?: string | undefined;
  readonly disabled?: boolean | undefined;
  readonly onClick?: (() => void) | undefined;
}

export function HeadButton(props: HeadButtonProps): ReactElement {
  const head = HEAD_BUTTONS[props.kind];
  return (
    <IconButton
      icon={head.icon}
      label={props.label ?? head.label}
      disabled={props.disabled}
      onClick={props.onClick}
    />
  );
}

export * from './controls-fields.tsx';
export * from './controls-toggles.tsx';
