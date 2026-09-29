// SPDX-License-Identifier: AGPL-3.0-only
//
// The signed-in person menu (C23, CS-2.9, FA-SHELL-30): at the far right of the
// app strip, who is signed in drawn as a presence circle (DS-PRIM-16), opening a
// menu (DS-PRIM-19) with their name, a link to their own settings (You) and
// Sign out. Not drawn in the mockup, so the look is those two kit parts and
// nothing of its own.
//
// The circle and the menu use the kit's own markup (`av av--person`, `menu`,
// `menu__opt`). Until the kit's `Avatar` and menu land (MP-1-3) their rules
// stand in from `styles/2b-kit-standin.css`, which goes when they do.

import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type ReactElement,
  type RefObject,
} from 'react';

export interface PersonMenuProps {
  /** The person's own name, or null while it is unknown; the email stands in. */
  readonly name: string | null;
  /** The address they signed in with. */
  readonly email: string;
  /** Where their own preferences are: `/settings/` (You). */
  readonly settingsHref: string;
  readonly onSettings: () => void;
  readonly onSignOut: () => void;
}

const initials = (name: string): string =>
  name
    .split(/\s+/u)
    .filter((part) => part !== '')
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('');

export function PersonMenu(props: PersonMenuProps): ReactElement {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const shown = props.name ?? props.email;
  return (
    <div className="who">
      <button
        ref={trigger}
        className="who__trigger"
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`${shown}, signed in`}
        title={shown}
        onClick={() => {
          setOpen((was) => !was);
        }}
      >
        <span className="av av--person" aria-hidden="true">
          {initials(shown)}
        </span>
      </button>
      {open ? (
        <MenuPanel
          {...props}
          shown={shown}
          trigger={trigger}
          onClose={(refocus) => {
            setOpen(false);
            if (refocus) trigger.current?.focus();
          }}
        />
      ) : null}
    </div>
  );
}

/**
 * The open menu: focus on its first item, arrows between items, one Escape
 * back to the circle, Tab or a press outside closes it.
 */
function MenuPanel(
  props: PersonMenuProps & {
    readonly shown: string;
    readonly trigger: RefObject<HTMLButtonElement | null>;
    readonly onClose: (refocus: boolean) => void;
  },
): ReactElement {
  const menu = useRef<HTMLDivElement | null>(null);
  const { onClose, trigger } = props;
  useFocusInClosedOutside(menu, trigger, onClose);

  return (
    <div
      ref={menu}
      className="menu who__menu"
      role="menu"
      aria-label="Signed in"
      onKeyDown={(event) => {
        onMenuKey(event, menu.current, onClose);
      }}
    >
      <div className="who__head" role="presentation">
        <span className="who__name">{props.shown}</span>
        {props.name === null ? null : <span className="who__email">{props.email}</span>}
      </div>
      <a
        className="menu__opt"
        role="menuitem"
        href={props.settingsHref}
        onClick={(event) => {
          followSettings(event, onClose, props.onSettings);
        }}
      >
        Your settings
      </a>
      <button
        className="menu__opt"
        role="menuitem"
        type="button"
        onClick={() => {
          onClose(false);
          props.onSignOut();
        }}
      >
        Sign out
      </button>
    </div>
  );
}

/**
 * A plain click on Your settings closes the menu and goes there in the app; a
 * click with another button or a modifier (a new tab or window) is the browser's.
 */
function followSettings(
  event: MouseEvent<HTMLAnchorElement>,
  onClose: (refocus: boolean) => void,
  onSettings: () => void,
): void {
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
    return;
  }
  event.preventDefault();
  onClose(false);
  onSettings();
}

/** Focus goes to the menu's first item on open; a press outside the menu and its circle closes it. */
function useFocusInClosedOutside(
  menu: RefObject<HTMLDivElement | null>,
  trigger: RefObject<HTMLButtonElement | null>,
  onClose: (refocus: boolean) => void,
): void {
  useEffect(() => {
    menu.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    const outside = (event: PointerEvent): void => {
      const target = event.target as Node | null;
      const inside = [menu.current, trigger.current].some(
        (each) => each?.contains(target) === true,
      );
      if (target !== null && !inside) onClose(false);
    };
    document.addEventListener('pointerdown', outside);
    return () => {
      document.removeEventListener('pointerdown', outside);
    };
  }, [menu, onClose, trigger]);
}

/** The menu's keys: arrows, Home and End between items, Escape back to the circle, Tab away. */
function onMenuKey(
  event: KeyboardEvent<HTMLDivElement>,
  menu: HTMLDivElement | null,
  onClose: (refocus: boolean) => void,
): void {
  const items = [...(menu?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
  const at = items.indexOf(document.activeElement as HTMLElement);
  const move = (to: number): void => {
    event.preventDefault();
    items[(to + items.length) % items.length]?.focus();
  };
  if (event.key === 'Escape') {
    // One Escape, this menu's: it does not also close a drawer behind it.
    event.preventDefault();
    event.stopPropagation();
    onClose(true);
  } else if (event.key === 'ArrowDown') move(at + 1);
  else if (event.key === 'ArrowUp') move(at - 1);
  else if (event.key === 'Home') move(0);
  else if (event.key === 'End') move(items.length - 1);
  else if (event.key === 'Tab') onClose(false);
}
