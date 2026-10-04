// SPDX-License-Identifier: AGPL-3.0-only
//
// The kit's fields (MP-1-3): the labelled field frame with its hint and its
// error (DS-PRIM-30), the text field, the search box and the select with its
// option menu. The rules for every control are in controls.tsx.

import {
  useId,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
  type RefObject,
} from 'react';
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

/** DS-PRIM-19's option menu: the listbox a select owns while it is open. */
function SelectMenu(props: {
  readonly id: string;
  readonly options: readonly Option[];
  readonly value: string;
  readonly active: number;
  readonly choose: (index: number) => void;
}): ReactElement {
  const { id } = props;
  return (
    <ul className="menu" role="listbox" id={`${id}-menu`} aria-labelledby={id}>
      {props.options.map((option, index) => (
        <li
          key={option.value}
          id={`${id}-opt-${String(index)}`}
          role="option"
          className={`menu__opt${index === props.active ? ' is-active' : ''}`}
          aria-selected={option.value === props.value}
          onMouseDown={(event) => {
            event.preventDefault();
          }}
          onClick={() => {
            props.choose(index);
          }}
        >
          {option.label}
          {option.value === props.value ? <Icon name="check" size="sm" /> : null}
        </li>
      ))}
    </ul>
  );
}

/** Where the select's value sits among its options, or the first option. */
const valueIndex = (props: SelectProps): number =>
  Math.max(
    0,
    props.options.findIndex((o) => o.value === props.value),
  );

/**
 * A select's open state, its active option and its keys: arrows open and walk, Enter and Space
 * choose, Escape closes the menu and goes no further. Opening starts at the current value; a
 * disabled select draws no menu.
 */
function useSelect(props: SelectProps): {
  readonly open: boolean;
  readonly toggle: () => void;
  readonly active: number;
  readonly trigger: RefObject<HTMLButtonElement | null>;
  readonly choose: (index: number) => void;
  readonly onKey: (event: KeyboardEvent) => void;
} {
  const [open, setOpen] = useState(props.defaultOpen === true);
  const [active, setActive] = useState(() => valueIndex(props));
  const trigger = useRef<HTMLButtonElement>(null);
  const shown = open && props.disabled !== true;
  const at = Math.min(active, props.options.length - 1);
  const openAtValue = (): void => {
    setActive(valueIndex(props));
    setOpen(true);
  };
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
    if (event.key === 'Escape' && shown) {
      event.preventDefault();
      event.stopPropagation();
      close();
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      // Walk from the option drawn active, so a list that shrank while open
      // never walks from an option it no longer has.
      if (shown)
        setActive(event.key === 'ArrowDown' ? Math.min(last, at + 1) : Math.max(0, at - 1));
      else openAtValue();
    } else if ((event.key === 'Enter' || event.key === ' ') && shown) {
      event.preventDefault();
      choose(at);
    }
  };
  const toggle = (): void => {
    if (shown) setOpen(false);
    else openAtValue();
  };
  return { open: shown, toggle, active: at, trigger, choose, onKey };
}

export function Select(props: SelectProps): ReactElement {
  const id = useId();
  const { open, toggle, active, trigger, choose, onKey } = useSelect(props);
  const current = props.options.find((o) => o.value === props.value);
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
          onClick={toggle}
          onKeyDown={onKey}
        >
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
          />
        ) : null}
      </div>
    </Field>
  );
}
