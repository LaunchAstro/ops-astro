// SPDX-License-Identifier: AGPL-3.0-only
//
// The Projects board's inline cell editors (MP-5-10, BOARDS P-37, DS-PRIM-5
// inline). A click on the cell opens its editor at once: the house menu, or a
// date field with its picker. While it is open the drawn value stays in the
// cell, hidden, and the editor lies over it, so the row keeps its height and
// the editor is the cell's size (R47); the menu hangs below, at least as wide
// as the cell. Escape and a press outside the cell cancel, saving nothing, and
// Escape goes no further than the cell (DS-PRIM-5 defect: it closed the host
// panel). The arrow keys move through the menu and never choose (the other
// DS-PRIM-5 defect); Enter or a click chooses. A day typed into the date field
// waits for Enter, so a half-typed year is never saved; a day picked from the
// picker saves at once. Choosing the value already there saves nothing.

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
} from 'react';

export interface MenuOption {
  readonly value: string;
  readonly label: string;
}

export type CellEditorSpec =
  | { readonly kind: 'menu'; readonly options: readonly MenuOption[]; readonly current: string }
  | { readonly kind: 'date'; readonly current: string };

export interface EditableCellProps {
  /** The trigger's accessible name, as "Change the stage of Menu copy". */
  readonly label: string;
  readonly editor: CellEditorSpec;
  /** Called with a changed value only. */
  readonly onChoose: (value: string) => void;
  /** The cell as drawn at rest. */
  readonly children: ReactNode;
}

export function EditableCell(props: EditableCellProps): ReactElement {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const refocus = useRef(false);
  useEffect(() => {
    if (!open && refocus.current) trigger.current?.focus();
    refocus.current = false;
  }, [open]);

  const onClose = useCallback((focusBack: boolean): void => {
    refocus.current = focusBack;
    setOpen(false);
  }, []);

  if (open) return <OpenCell {...props} onClose={onClose} />;
  return (
    <div className="cbd__cell">
      <button
        ref={trigger}
        type="button"
        className="cbd__edb"
        aria-label={props.label}
        aria-haspopup={props.editor.kind === 'menu' ? 'listbox' : undefined}
        onClick={() => {
          setOpen(true);
        }}
      >
        {props.children}
      </button>
    </div>
  );
}

/** The cell with its editor open over the drawn value; a press outside it cancels. */
function OpenCell(
  props: EditableCellProps & { readonly onClose: (focusBack: boolean) => void },
): ReactElement {
  const { onClose } = props;
  const cell = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // Registered after the opening click has finished, so it never hears it.
    const outside = (event: MouseEvent): void => {
      if (!(event.target instanceof Node) || !cell.current?.contains(event.target)) onClose(false);
    };
    document.addEventListener('mousedown', outside);
    return () => {
      document.removeEventListener('mousedown', outside);
    };
  }, [onClose]);
  const choose = (value: string, focusBack: boolean): void => {
    onClose(focusBack);
    if (value !== props.editor.current) props.onChoose(value);
  };
  return (
    <div className="cbd__cell is-editing" ref={cell}>
      <span className="cbd__cellv" aria-hidden="true">
        {props.children}
      </span>
      <div className="cbd__ed">
        {props.editor.kind === 'menu' ? (
          <Menu label={props.label} spec={props.editor} onChoose={choose} onCancel={onClose} />
        ) : (
          <DateField label={props.label} spec={props.editor} onChoose={choose} onCancel={onClose} />
        )}
      </div>
    </div>
  );
}

interface EditorProps<Spec> {
  readonly label: string;
  readonly spec: Spec;
  readonly onChoose: (value: string, focusBack: boolean) => void;
  readonly onCancel: (focusBack: boolean) => void;
}

/** Escape stops at the cell: the board's own keys and any host panel never see it. */
function cancelled(event: KeyboardEvent, onCancel: (focusBack: boolean) => void): boolean {
  if (event.key !== 'Escape') return false;
  event.preventDefault();
  event.stopPropagation();
  onCancel(true);
  return true;
}

/** The menu's active option and its keys: the arrows move, Enter or Space chooses. */
function useMenuKeys(props: EditorProps<Extract<CellEditorSpec, { readonly kind: 'menu' }>>) {
  const { options, current } = props.spec;
  const [active, setActive] = useState(() =>
    Math.max(
      0,
      options.findIndex((option) => option.value === current),
    ),
  );
  const onKeyDown = (event: KeyboardEvent<HTMLUListElement>): void => {
    if (cancelled(event, props.onCancel)) return;
    const last = options.length - 1;
    const moves: Readonly<Record<string, number>> = {
      ArrowDown: Math.min(last, active + 1),
      ArrowUp: Math.max(0, active - 1),
      Home: 0,
      End: last,
    };
    const next = moves[event.key];
    if (next !== undefined) {
      event.preventDefault();
      setActive(next);
      return;
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      const option = options[active];
      if (option !== undefined) props.onChoose(option.value, true);
    }
  };
  return { active, setActive, onKeyDown };
}

function Menu(
  props: EditorProps<Extract<CellEditorSpec, { readonly kind: 'menu' }>>,
): ReactElement {
  const { options, current } = props.spec;
  const id = useId();
  const list = useRef<HTMLUListElement>(null);
  const { active, setActive, onKeyDown } = useMenuKeys(props);
  useEffect(() => {
    list.current?.focus();
  }, []);
  const shown = options.find((option) => option.value === current)?.label ?? '';
  return (
    <div className="sel sel--inline">
      <span className="sel__btn is-open" aria-hidden="true">
        {shown}
      </span>
      <ul
        ref={list}
        className="sel__menu"
        role="listbox"
        tabIndex={-1}
        aria-label={props.label}
        aria-activedescendant={`${id}-${String(active)}`}
        onKeyDown={onKeyDown}
      >
        {options.map((option, at) => (
          <li
            key={option.value}
            id={`${id}-${String(at)}`}
            role="option"
            aria-selected={option.value === current}
            className={at === active ? 'sel__opt is-active' : 'sel__opt'}
            onMouseEnter={() => {
              setActive(at);
            }}
            onClick={() => {
              props.onChoose(option.value, false);
            }}
          >
            {option.label}
          </li>
        ))}
      </ul>
    </div>
  );
}

function DateField(
  props: EditorProps<Extract<CellEditorSpec, { readonly kind: 'date' }>>,
): ReactElement {
  const field = useRef<HTMLInputElement>(null);
  // A key pressed in the field since the last change: the change was typed.
  const keyed = useRef(false);
  useEffect(() => {
    const input = field.current;
    if (input === null) return;
    input.focus();
    try {
      input.showPicker();
    } catch {
      // No picker here, or none allowed: the field is open and focused.
    }
  }, []);

  return (
    <input
      ref={field}
      className="cbd__date"
      type="date"
      aria-label={props.label}
      defaultValue={props.spec.current}
      onKeyDown={(event) => {
        if (cancelled(event, props.onCancel)) return;
        if (event.key === 'Enter') {
          event.preventDefault();
          if (!event.currentTarget.validity.badInput) {
            props.onChoose(event.currentTarget.value, true);
          }
          return;
        }
        if (event.key !== 'Tab') keyed.current = true;
      }}
      onChange={(event) => {
        const typed = keyed.current;
        keyed.current = false;
        // A half-typed day reads as empty and bad; a typed day waits for Enter.
        if (typed || event.currentTarget.validity.badInput) return;
        props.onChoose(event.currentTarget.value, false);
      }}
    />
  );
}
