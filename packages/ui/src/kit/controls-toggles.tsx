// SPDX-License-Identifier: AGPL-3.0-only
//
// The kit's toggles (MP-1-3): the checkbox, the switch, the segmented control
// and facet, and the disclosure. The rules for every control are in
// controls.tsx.

import { type ReactElement } from 'react';
import { Icon } from '../primitives/Icon.tsx';
import type { Option } from './controls-fields.tsx';

/** DS-PRIM-7. Checked is an outline and a tick, never a fill. */
export interface CheckboxProps {
  readonly label: string;
  readonly checked: boolean;
  readonly onChange: (checked: boolean) => void;
  readonly disabled?: boolean | undefined;
}

export function Checkbox(props: CheckboxProps): ReactElement {
  return (
    <button
      type="button"
      role="checkbox"
      className="check"
      aria-checked={props.checked}
      aria-label={props.label}
      disabled={props.disabled}
      onClick={() => {
        props.onChange(!props.checked);
      }}
    >
      {props.checked ? <Icon name="check" size="sm" /> : null}
    </button>
  );
}

/** DS-PRIM-9. A standing setting with immediate effect. */
export interface SwitchProps {
  readonly label: string;
  readonly on: boolean;
  readonly onChange: (on: boolean) => void;
  readonly disabled?: boolean | undefined;
  readonly reason?: string | undefined;
}

export function Switch(props: SwitchProps): ReactElement {
  return (
    <button
      type="button"
      role="switch"
      className="switch"
      aria-checked={props.on}
      aria-label={props.label}
      title={props.disabled === true ? props.reason : undefined}
      disabled={props.disabled}
      onClick={() => {
        props.onChange(!props.on);
      }}
    >
      <span className="switch__knob" aria-hidden="true" />
    </button>
  );
}

/** DS-PRIM-10: the segmented control (one bordered group) and the facet (separate, with a count). */
export interface SegmentedProps {
  readonly label: string;
  readonly options: readonly (Option & { readonly count?: number | undefined })[];
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly look?: 'segmented' | 'facet' | undefined;
}

export function Segmented(props: SegmentedProps): ReactElement {
  const look = props.look ?? 'segmented';
  return (
    <div
      className={look === 'facet' ? 'facets' : 'segmented'}
      role="group"
      aria-label={props.label}
    >
      {props.options.map((option) => (
        <button
          key={option.value}
          type="button"
          className={look === 'facet' ? 'facet' : 'segmented__opt'}
          aria-pressed={option.value === props.value}
          onClick={() => {
            props.onChange(option.value);
          }}
        >
          {option.label}
          {option.count === undefined ? null : <span className="facet__num">{option.count}</span>}
        </button>
      ))}
    </div>
  );
}

/** DS-PRIM-31. The chevron turns down when open. */
export interface DisclosureProps {
  readonly label: string;
  readonly open: boolean;
  readonly onToggle: (open: boolean) => void;
  readonly controls: string;
}

export function Disclosure(props: DisclosureProps): ReactElement {
  return (
    <button
      type="button"
      className="ibtn disclosure"
      aria-label={props.label}
      aria-expanded={props.open}
      aria-controls={props.controls}
      onClick={() => {
        props.onToggle(!props.open);
      }}
    >
      <Icon name="angle-small-right" />
    </button>
  );
}
