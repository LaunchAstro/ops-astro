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

import {
  useId,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
} from 'react';
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

interface FieldFrame {
  readonly label: string;
  readonly hint?: string | undefined;
  /** DS-PRIM-30's field error: the border turns `--danger` and this line says why. */
  readonly error?: string | undefined;
}

function Field(
  props: FieldFrame & { readonly id: string; readonly children: ReactNode },
): ReactElement {
  return (
    <div className="field">
      <label className="field__label" htmlFor={props.id}>
        {props.label}
      </label>
      {props.children}
      {props.error === undefined ? null : (
        <p className="field__error" id={`${props.id}-error`}>
          {props.error}
        </p>
      )}
      {props.hint === undefined || props.error !== undefined ? null : (
        <p className="field__hint" id={`${props.id}-hint`}>
          {props.hint}
        </p>
      )}
    </div>
  );
}

const describedBy = (id: string, frame: FieldFrame): string | undefined =>
  frame.error === undefined ? (frame.hint === undefined ? undefined : `${id}-hint`) : `${id}-error`;

/** DS-PRIM-3 and DS-PRIM-4. */
export interface TextFieldProps extends FieldFrame {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly placeholder?: string | undefined;
  readonly multiline?: boolean | undefined;
  /** The rename-in-place look, for a title edited where it stands. */
  readonly inline?: boolean | undefined;
  readonly disabled?: boolean | undefined;
}

export function TextField(props: TextFieldProps): ReactElement {
  const id = useId();
  const shared = {
    id,
    className: `${props.multiline === true ? 'ta' : 'tf'}${props.inline === true ? ' tf--inline' : ''}`,
    value: props.value,
    placeholder: props.placeholder,
    disabled: props.disabled,
    'aria-invalid': props.error === undefined ? undefined : true,
    'aria-describedby': describedBy(id, props),
    onChange: (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      props.onChange(event.target.value);
    },
  };
  return (
    <Field id={id} label={props.label} hint={props.hint} error={props.error}>
      {props.multiline === true ? <textarea {...shared} /> : <input type="text" {...shared} />}
    </Field>
  );
}

/** DS-PRIM-6. The keycap names a shortcut; the box is still a plain search field. */
export interface SearchBoxProps {
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly placeholder?: string | undefined;
  readonly keycap?: string | undefined;
}

export function SearchBox(props: SearchBoxProps): ReactElement {
  return (
    <div className="search">
      <Icon name="search" size="sm" />
      <input
        type="search"
        className="search__in"
        aria-label={props.label}
        placeholder={props.placeholder}
        value={props.value}
        onChange={(event) => {
          props.onChange(event.target.value);
        }}
      />
      {props.keycap === undefined ? null : <kbd className="keycap">{props.keycap}</kbd>}
    </div>
  );
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
  readonly disabled?: boolean | undefined;
  /** Drawn open, for the gallery's capture of the open state. */
  readonly defaultOpen?: boolean | undefined;
}

export function Select(props: SelectProps): ReactElement {
  const id = useId();
  const [open, setOpen] = useState(props.defaultOpen === true);
  const [active, setActive] = useState(() =>
    Math.max(
      0,
      props.options.findIndex((o) => o.value === props.value),
    ),
  );
  const trigger = useRef<HTMLButtonElement>(null);
  const current = props.options.find((o) => o.value === props.value);
  const close = (): void => {
    setOpen(false);
    trigger.current?.focus();
  };
  const choose = (index: number): void => {
    const option = props.options[index];
    if (option !== undefined) props.onChange(option.value);
    close();
  };
  const onKey = (event: KeyboardEvent): void => {
    const last = props.options.length - 1;
    if (event.key === 'Escape' && open) {
      event.preventDefault();
      close();
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!open) setOpen(true);
      else
        setActive((i) => (event.key === 'ArrowDown' ? Math.min(last, i + 1) : Math.max(0, i - 1)));
    } else if ((event.key === 'Enter' || event.key === ' ') && open) {
      event.preventDefault();
      choose(active);
    }
  };
  return (
    <Field id={id} label={props.label} hint={props.hint} error={props.error}>
      <div className="sel">
        <button
          ref={trigger}
          id={id}
          type="button"
          className="sel__btn"
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-controls={`${id}-menu`}
          aria-activedescendant={open ? `${id}-opt-${String(active)}` : undefined}
          aria-invalid={props.error === undefined ? undefined : true}
          aria-describedby={describedBy(id, props)}
          disabled={props.disabled}
          onClick={() => {
            setOpen((was) => !was);
          }}
          onKeyDown={onKey}
        >
          <span className="sel__value">{current?.label ?? ''}</span>
          <span className="sel__caret" aria-hidden="true" />
        </button>
        {open ? (
          <ul className="menu" role="listbox" id={`${id}-menu`} aria-labelledby={id}>
            {props.options.map((option, index) => (
              <li
                key={option.value}
                id={`${id}-opt-${String(index)}`}
                role="option"
                className={`menu__opt${index === active ? ' is-active' : ''}`}
                aria-selected={option.value === props.value}
                onMouseDown={(event) => {
                  event.preventDefault();
                }}
                onClick={() => {
                  choose(index);
                }}
              >
                {option.label}
                {option.value === props.value ? <Icon name="check" size="sm" /> : null}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </Field>
  );
}

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
