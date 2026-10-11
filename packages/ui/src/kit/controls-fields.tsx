// SPDX-License-Identifier: AGPL-3.0-only
//
// The kit's fields (MP-1-3): the labelled field frame with its hint and its
// error (DS-PRIM-30), the text field, the search box and the select with its
// option menu. The rules for every control are in controls.tsx.

import { useId, useEffect, type ChangeEvent, type ReactElement, type ReactNode } from 'react';
import { useSelect } from './select-state.ts';
import { Icon } from '../primitives/Icon.tsx';

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
  readonly disabled?: boolean;
}

/** DS-PRIM-5, opening DS-PRIM-19's option menu. */
export interface SelectProps extends FieldFrame {
  readonly options: readonly Option[];
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly disabled?: boolean | undefined;
  /** Drawn open, for the gallery's capture of the open state. */
  readonly defaultOpen?: boolean | undefined;
  readonly optionLeading?: ((value: string) => ReactNode) | undefined;
}

/** DS-PRIM-19's option menu: the listbox a select owns while it is open. */
function SelectMenu(props: {
  readonly id: string;
  readonly options: readonly Option[];
  readonly value: string;
  readonly active: number;
  readonly choose: (index: number) => void;
  readonly optionLeading?: ((value: string) => ReactNode) | undefined;
}): ReactElement {
  const { id } = props;
  return (
    <ul className="menu menu--select" role="listbox" id={`${id}-menu`} aria-labelledby={id}>
      {props.options.map((option, index) => (
        <li
          key={option.value}
          id={`${id}-opt-${String(index)}`}
          role="option"
          className={`menu__opt${index === props.active ? ' is-active' : ''}`}
          aria-selected={option.value === props.value}
          aria-disabled={option.disabled === true ? true : undefined}
          onMouseDown={(event) => {
            event.preventDefault();
          }}
          onClick={() => {
            if (option.disabled !== true) props.choose(index);
          }}
        >
          <span className="menu__check" aria-hidden="true">
            {option.value === props.value ? <Icon name="check" size="xs" /> : null}
          </span>
          {props.optionLeading?.(option.value)}
          <span>{option.label}</span>
        </li>
      ))}
    </ul>
  );
}

export function Select(props: SelectProps): ReactElement {
  const id = useId();
  return (
    <Field id={id} label={props.label} hint={props.hint} error={props.error}>
      <SelectControl {...props} id={id} />
    </Field>
  );
}

/** Keeps the active option in view by scrolling the open menu alone, never the page. */
function useActiveInView(id: string, open: boolean, active: number): void {
  useEffect(() => {
    // eslint-disable-next-line unicorn/prefer-query-selector -- opaque React ids need no CSS escaping here.
    const option = open ? document.getElementById(`${id}-opt-${String(active)}`) : null;
    const menu = option?.parentElement;
    if (!option || !menu) return;
    const shown = menu.getBoundingClientRect();
    const at = option.getBoundingClientRect();
    if (at.top < shown.top) menu.scrollTop -= shown.top - at.top;
    else if (at.bottom > shown.bottom) menu.scrollTop += at.bottom - shown.bottom;
  }, [id, open, active]);
}

/** The same menu without a second label, for inline forms and drawer fields. */
export function SelectControl(
  props: SelectProps & { readonly id: string; readonly leading?: ReactNode },
): ReactElement {
  const { id } = props;
  const { open, toggle, active, trigger, choose, onKey } = useSelect(props);
  const current = props.options.find((o) => o.value === props.value);
  useActiveInView(id, open, active);
  return (
    <div className={`sel${open ? ' is-open' : ''}`}>
      <button
        ref={trigger}
        id={id}
        type="button"
        className="sel__btn"
        aria-label={props.label}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={`${id}-menu`}
        aria-activedescendant={open ? `${id}-opt-${String(active)}` : undefined}
        aria-invalid={props.error === undefined ? undefined : true}
        aria-describedby={describedBy(id, props)}
        disabled={props.disabled}
        onClick={toggle}
        onKeyDown={onKey}
      >
        {props.leading}
        <span className="sel__value">{current?.label ?? ''}</span>
        <span className="sel__caret" aria-hidden="true" />
      </button>
      {open ? (
        <SelectMenu
          id={id}
          options={props.options}
          value={props.value}
          active={active}
          choose={choose}
          optionLeading={props.optionLeading}
        />
      ) : null}
    </div>
  );
}
