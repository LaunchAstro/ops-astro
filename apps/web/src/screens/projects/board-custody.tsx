// SPDX-License-Identifier: AGPL-3.0-only
import { Activity, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

/** A checked owner withdraws its editor during a read, then returns it only after admission. */
export function BoardCustody(props: {
  readonly drawn: boolean;
  readonly clear: boolean;
  readonly children: ReactNode;
}) {
  const [container] = useState(() => document.createElement('div'));
  const host = useRef<HTMLDivElement>(null);
  const held = useRef<ReactNode>(null);
  const focus = useRef<HTMLElement | null>(null);
  if (props.clear) held.current = null;
  else if (props.drawn) held.current = props.children;
  useLayoutEffect(() => {
    if (props.drawn) {
      host.current?.append(container);
      if (focus.current?.isConnected && document.activeElement === document.body)
        focus.current.focus();
      focus.current = null;
    } else {
      if (
        document.activeElement instanceof HTMLElement &&
        container.contains(document.activeElement)
      )
        focus.current = document.activeElement;
      container.remove();
    }
    if (props.clear) focus.current = null;
    return () => {
      if (
        document.activeElement instanceof HTMLElement &&
        container.contains(document.activeElement)
      )
        focus.current = document.activeElement;
      container.remove();
    };
  }, [container, props.drawn, props.clear]);
  return (
    <>
      <div ref={host} />
      {createPortal(
        <Activity mode={props.drawn ? 'visible' : 'hidden'}>{held.current}</Activity>,
        container,
      )}
    </>
  );
}
