// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useRef, useState, type KeyboardEvent, type RefObject } from 'react';

/** What a select's keys and menu read: its options, its value and how a choice is reported. */
interface Choices {
  readonly options: readonly {
    readonly value: string;
    readonly label: string;
    readonly disabled?: boolean | undefined;
  }[];
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly disabled?: boolean | undefined;
  readonly defaultOpen?: boolean | undefined;
}

/** Where the select's value sits among its options, or the first option. */
const valueIndex = (props: Choices): number =>
  Math.max(
    0,
    props.options.findIndex((o) => o.value === props.value),
  );

/**
 * A select's open state, its active option and its keys: arrows open and walk, Enter and Space
 * choose, Escape closes the menu and goes no further. Opening starts at the current value; a
 * disabled select draws no menu.
 */
// eslint-disable-next-line max-lines-per-function -- one controller owns keyboard navigation, focus and dismissal together.
export function useSelect(props: Choices): {
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
  const typed = useRef({ text: '', at: 0 });
  useEffect(() => {
    if (!open) return;
    const dismiss = (event: PointerEvent): void => {
      if (event.target instanceof Node && !trigger.current?.parentElement?.contains(event.target))
        setOpen(false);
    };
    document.addEventListener('pointerdown', dismiss);
    return () => document.removeEventListener('pointerdown', dismiss);
  }, [open]);
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
    if (option !== undefined && option.disabled !== true) props.onChange(option.value);
    close();
  };
  const enabledAt = (from: number, direction: 1 | -1): number => {
    for (let index = from; index >= 0 && index < props.options.length; index += direction) {
      if (props.options[index]?.disabled !== true) return index;
    }
    return at;
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
        setActive(event.key === 'ArrowDown' ? enabledAt(at + 1, 1) : enabledAt(at - 1, -1));
      else openAtValue();
    } else if ((event.key === 'Home' || event.key === 'End') && shown) {
      event.preventDefault();
      setActive(event.key === 'Home' ? enabledAt(0, 1) : enabledAt(last, -1));
    } else if ((event.key === 'Enter' || event.key === ' ') && shown) {
      event.preventDefault();
      choose(at);
    } else if ((event.key === 'Enter' || event.key === ' ') && !shown) {
      event.preventDefault();
      openAtValue();
    } else if (event.key === 'Tab') {
      setOpen(false);
    } else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault();
      const now = Date.now();
      const text =
        (now - typed.current.at > 700 ? '' : typed.current.text) + event.key.toLowerCase();
      typed.current = { text, at: now };
      const found = props.options.findIndex(
        (option) => option.disabled !== true && option.label.toLowerCase().startsWith(text),
      );
      if (found >= 0) {
        setActive(found);
        setOpen(true);
      }
    }
  };
  const toggle = (): void => {
    if (shown) setOpen(false);
    else openAtValue();
  };
  return { open: shown, toggle, active: at, trigger, choose, onKey };
}
