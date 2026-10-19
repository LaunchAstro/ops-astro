// SPDX-License-Identifier: AGPL-3.0-only
//
// Where things sit on a capture (C35, #2105): a landed picture's size, read from its PNG
// header so the pins can be drawn over it before it has loaded, and a pin's spot, the media
// fragment `xywh` of its anchor in the capture's own pixels: a capture is its width wide
// whatever the picture's pixel ratio, so the picture is drawn scaled to that width.

import type { ReviewReadResult } from '../../../../../packages/core-wire/src/index.ts';

export type Pin = ReviewReadResult['review']['pins'][number];

export interface Size {
  readonly width: number;
  readonly height: number;
}

export interface Spot extends Size {
  readonly x: number;
  readonly y: number;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** A PNG's width and height from its header; undefined for anything that is not a PNG. */
function pngSize(base64: string): Size | undefined {
  let head: string;
  try {
    head = atob(base64.slice(0, 32));
  } catch {
    return undefined;
  }
  const byte = (at: number): number => head.codePointAt(at) ?? -1;
  if (head.length < 24 || PNG_SIGNATURE.some((value, at) => byte(at) !== value)) return undefined;
  if (head.slice(12, 16) !== 'IHDR') return undefined;
  const word = (at: number): number =>
    ((byte(at) << 24) | (byte(at + 1) << 16) | (byte(at + 2) << 8) | byte(at + 3)) >>> 0;
  const size = { width: word(16), height: word(20) };
  return size.width > 0 && size.height > 0 ? size : undefined;
}

/** The picture drawn `width` wide: its height scaled with it, or undefined for a non-PNG. */
export function drawnSize(base64: string, width: number): Size | undefined {
  const size = pngSize(base64);
  return size === undefined
    ? undefined
    : { width, height: Math.max(1, Math.round((size.height * width) / size.width)) };
}

const XYWH = /^xywh=(?:pixel:)?(\d+),(\d+),(\d+),(\d+)$/u;

/** The pin's spot on its capture, from its fragment selector; null when it has none. */
export function spotOf(pin: Pin): Spot | null {
  for (const selector of pin.anchor.selector) {
    const match = selector.type === 'FragmentSelector' ? XYWH.exec(selector.value) : null;
    if (match !== null) {
      const [x, y, width, height] = match.slice(1).map(Number);
      if (x !== undefined && y !== undefined && width !== undefined && height !== undefined) {
        return { x, y, width, height };
      }
    }
  }
  return null;
}

/** Where a span centred on `at` starts, kept inside `0..most`. */
const clamp = (at: number, span: number, most: number): number =>
  Math.min(Math.max(0, Math.round(at - span / 2)), Math.max(0, most - span));

/** A spot a click marks: a tenth of the capture wide, 48 pixels high, kept on the capture. */
export function spotAround(x: number, y: number, size: Size): Spot {
  const width = Math.max(24, Math.round(size.width / 10));
  const height = Math.min(48, size.height);
  return {
    x: clamp(x, width, size.width),
    y: clamp(y, height, size.height),
    width: Math.min(width, size.width),
    height,
  };
}

export const xywh = (spot: Spot): string =>
  `xywh=${String(spot.x)},${String(spot.y)},${String(spot.width)},${String(spot.height)}`;
