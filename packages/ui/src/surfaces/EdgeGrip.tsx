// SPDX-License-Identifier: AGPL-3.0-only
//
// The edge grip (DS-SIDE-10): one separator on the edge of whatever it sizes,
// by pointer or by keys. The dock's panels share one width on their left edge
// (MP-3-2), the sheet one height on its top edge (MP-3-3), and the nav rail
// its width on its right edge (MP-2-3). The arrows step it, shift steps it
// further, Home resets it; a drag moves it live and is kept when let go.

import { useRef, type KeyboardEvent, type PointerEvent, type ReactElement } from 'react';

const STEP = 16;
const BIG_STEP = 64;

/**
 * Which edge of the sized thing the grip sits on, and so which way is bigger.
 * On the left edge the thing is anchored right: a pointer moved left by d
 * widens each of `per` panels by d / per, and ArrowLeft widens. On the top
 * edge a pointer moved up by d makes it d taller, and ArrowUp does. On the
 * right edge a pointer moved right by d makes it d wider, and ArrowRight does.
 */
export type GripEdge = 'left' | 'top' | 'right';

const GROWS: Readonly<Record<GripEdge, { grow: string; shrink: string; sign: 1 | -1 }>> = {
  left: { grow: 'ArrowLeft', shrink: 'ArrowRight', sign: -1 },
  top: { grow: 'ArrowUp', shrink: 'ArrowDown', sign: -1 },
  right: { grow: 'ArrowRight', shrink: 'ArrowLeft', sign: 1 },
};

export interface EdgeGripProps {
  readonly edge: GripEdge;
  readonly className: string;
  readonly label: string;
  readonly value: number;
  readonly min: number;
  readonly max?: number | undefined;
  readonly reset: number;
  readonly per: number;
  readonly onDragging: (dragging: boolean) => void;
  readonly onChange: ((value: number) => void) | undefined;
  readonly onCommit: ((value: number) => void) | undefined;
}

/** A drag in progress: its own pointer, where it began and the value then. */
interface Drag {
  readonly pointer: number;
  readonly at: number;
  readonly value: number;
}

/** Whether `event` is the drag's own pointer: another finger neither moves nor ends it. */
const owns = (drag: Drag | null, event: PointerEvent<HTMLDivElement>): boolean =>
  drag?.pointer === event.pointerId;

/** Where a pointer is along the axis the grip sizes. */
const along = (edge: GripEdge, event: PointerEvent<HTMLDivElement>): number =>
  edge === 'top' ? event.clientY : event.clientX;

export function EdgeGrip(props: EdgeGripProps): ReactElement {
  const start = useRef<Drag | null>(null);
  const { sign } = GROWS[props.edge];
  const at = (point: number): number => {
    const from = start.current ?? { at: point, value: props.value };
    return held(props, from.value + (sign * (point - from.at)) / props.per);
  };
  const onPointerDown = (event: PointerEvent<HTMLDivElement>): void => {
    if (start.current !== null && !owns(start.current, event)) return;
    start.current = { pointer: event.pointerId, at: along(props.edge, event), value: props.value };
    event.currentTarget.setPointerCapture(event.pointerId);
    props.onDragging(true);
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>): void => {
    if (owns(start.current, event)) props.onChange?.(at(along(props.edge, event)));
  };
  const onPointerUp = (event: PointerEvent<HTMLDivElement>): void => {
    if (!owns(start.current, event)) return;
    const value = at(along(props.edge, event));
    start.current = null;
    props.onDragging(false);
    props.onCommit?.(value);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const next = keyed(props, event);
    if (next === null) return;
    event.preventDefault();
    const value = held(props, next);
    props.onChange?.(value);
    props.onCommit?.(value);
  };
  return (
    <div
      className={props.className}
      role="separator"
      aria-orientation={props.edge === 'top' ? 'horizontal' : 'vertical'}
      aria-label={props.label}
      aria-valuenow={props.value}
      aria-valuemin={props.min}
      aria-valuemax={props.max}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onKeyDown={onKeyDown}
    />
  );
}

/** The value held to the grip's range, in whole pixels. */
function held(props: EdgeGripProps, value: number): number {
  return Math.max(props.min, Math.min(Math.round(value), props.max ?? Number.POSITIVE_INFINITY));
}

/** Where a key moves the grip's value, before it is held to its range: null for a key it ignores. */
function keyed(props: EdgeGripProps, event: KeyboardEvent<HTMLDivElement>): number | null {
  const { grow, shrink } = GROWS[props.edge];
  const step = event.shiftKey ? BIG_STEP : STEP;
  if (event.key === grow) return props.value + step;
  if (event.key === shrink) return props.value - step;
  return event.key === 'Home' ? props.reset : null;
}
