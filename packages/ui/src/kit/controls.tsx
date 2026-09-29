// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-1-3 stub, replaced by the change that follows the red tests.

import type { ReactElement, ReactNode } from 'react';
import type { GlyphName } from '../primitives/Icon.tsx';

interface FieldFrame {
  readonly label: string;
  readonly hint?: string;
  readonly error?: string;
}

/** DS-PRIM-1. */
export interface ButtonProps {
  readonly children: ReactNode;
  readonly variant?: 'primary' | 'secondary' | 'ghost' | 'text';
  /** `sm` is the house default; `md` pairs with a 38 input; `lg` is the portal call to action. */
  readonly size?: 'sm' | 'md' | 'lg';
  readonly icon?: GlyphName;
  /** A toggle button (the filter preset): pressed draws the ink fill. */
  readonly pressed?: boolean;
  /** DS-PRIM-29's busy button: the label is swapped for this and the button is held. */
  readonly busy?: string;
  readonly disabled?: boolean;
  /** Why it is disabled, when the capability is not built yet. Shown as its tooltip. */
  readonly reason?: string;
  readonly type?: 'button' | 'submit';
  readonly onClick?: () => void;
}

/** DS-PRIM-2. The accessible name is required: the glyph says nothing to a screen reader. */
export interface IconButtonProps {
  readonly icon: GlyphName;
  readonly label: string;
  /** Default 26 square; compact 22 for dense rows (DR-23). */
  readonly size?: 'default' | 'compact';
  /** `accent` is "the agent asks" (WIRING §90); `danger` is remove. */
  readonly tone?: 'accent' | 'danger';
  /** Hidden until its row is hovered, above 900 only (DR-24). */
  readonly reveal?: boolean;
  readonly expanded?: boolean;
  readonly disabled?: boolean;
  readonly reason?: string;
  readonly onClick?: () => void;
}

/** The dock panel head's buttons (DOCK D-26): one component, built on DS-PRIM-2. */
export interface HeadButtonProps {
  readonly kind: 'close' | 'back' | 'forward' | 'new' | 'close-all';
  /** Overrides the default name, for example "New task". */
  readonly label?: string;
  readonly disabled?: boolean;
  readonly onClick?: () => void;
}

/** DS-PRIM-3 and DS-PRIM-4. */
export interface TextFieldProps extends FieldFrame {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly placeholder?: string;
  readonly multiline?: boolean;
  /** The rename-in-place look, for a title edited where it stands. */
  readonly inline?: boolean;
  readonly disabled?: boolean;
}

/** DS-PRIM-6. The keycap names a shortcut; the box is still a plain search field. */
export interface SearchBoxProps {
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly placeholder?: string;
  readonly keycap?: string;
}

export interface Option {
  readonly value: string;
  readonly label: string;
}

/** DS-PRIM-5, opening DS-PRIM-19's option menu. */
export interface SelectProps extends FieldFrame {
  readonly options: readonly Option[];
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly disabled?: boolean;
  /** Drawn open, for the gallery's capture of the open state. */
  readonly defaultOpen?: boolean;
}

/** DS-PRIM-7. Checked is an outline and a tick, never a fill. */
export interface CheckboxProps {
  readonly label: string;
  readonly checked: boolean;
  readonly onChange: (checked: boolean) => void;
  readonly disabled?: boolean;
}

/** DS-PRIM-9. A standing setting with immediate effect. */
export interface SwitchProps {
  readonly label: string;
  readonly on: boolean;
  readonly onChange: (on: boolean) => void;
  readonly disabled?: boolean;
  readonly reason?: string;
}

/** DS-PRIM-10: the segmented control (one bordered group) and the facet (separate, with a count). */
export interface SegmentedProps {
  readonly label: string;
  readonly options: readonly (Option & { readonly count?: number })[];
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly look?: 'segmented' | 'facet';
}

/** DS-PRIM-31. The chevron turns down when open. */
export interface DisclosureProps {
  readonly label: string;
  readonly open: boolean;
  readonly onToggle: (open: boolean) => void;
  readonly controls: string;
}

export function Button(_props: ButtonProps): ReactElement | null {
  return null;
}

export function IconButton(_props: IconButtonProps): ReactElement | null {
  return null;
}

export function HeadButton(_props: HeadButtonProps): ReactElement | null {
  return null;
}

export function TextField(_props: TextFieldProps): ReactElement | null {
  return null;
}

export function SearchBox(_props: SearchBoxProps): ReactElement | null {
  return null;
}

export function Select(_props: SelectProps): ReactElement | null {
  return null;
}

export function Checkbox(_props: CheckboxProps): ReactElement | null {
  return null;
}

export function Switch(_props: SwitchProps): ReactElement | null {
  return null;
}

export function Segmented(_props: SegmentedProps): ReactElement | null {
  return null;
}

export function Disclosure(_props: DisclosureProps): ReactElement | null {
  return null;
}
