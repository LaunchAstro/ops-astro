// SPDX-License-Identifier: AGPL-3.0-only
//
// C35's pin anchor (#2012), parsed: a W3C Web Annotation target on one width's capture. It sits
// beside the storable-text rule (`values.ts`) rather than in core records, which holds the
// anchor's type (`review/pins.ts`). The source is
// the revision; the selectors are a union judged by type, each parsed by its own row in
// `SELECTORS`, so a new kind (a time point or a region on a frame, #2041 and #2042) is a row
// rather than a branch. Today a target carries exactly one media fragment `xywh` inside the
// capture, and at most one text quote when there is text under the spot. Whether the
// revision exists and has that width's capture is the caller's to read (`pins.ts`).

import { CAPTURE_WIDTHS, isUuid } from '../../../core-records/src/index.ts';
import type { Anchor, CaptureWidth, Selector } from '../../../core-records/src/index.ts';
import { storableText } from './values.ts';

/**
 * The tallest capture a spot may sit on: the largest image a browser renders in one piece.
 * The landed picture's own height narrows this once pictures are kept (#2105).
 */
export const MOST_CAPTURE_HEIGHT = 16_384;

const MEDIA_FRAGMENTS = 'http://www.w3.org/TR/media-frags/';
/** `xywh=` in pixels, the unit said or left out; four whole numbers, no spaces. */
const XYWH = /^xywh=(?:pixel:)?(\d{1,5}),(\d{1,5}),(\d{1,5}),(\d{1,5})$/u;
const MOST_QUOTE = 1024;
const MOST_QUOTE_CONTEXT = 256;
const MOST_SELECTORS = 2;

export type AnchorParse =
  | { readonly ok: true; readonly anchor: Anchor }
  | { readonly ok: false; readonly names: readonly string[] };

type Sent = Readonly<Record<string, unknown>>;

const onlyKeys = (sent: Sent, allowed: readonly string[]): boolean =>
  Object.keys(sent).every((key) => allowed.includes(key));

const text = (value: unknown, least: number, most: number): value is string =>
  typeof value === 'string' && value.length >= least && value.length <= most && storableText(value);

type Parse = (sent: Sent, width: CaptureWidth) => Selector | null;

/**
 * Each selector type's parser: the selector as written, or null when it is malformed. A Map,
 * so a type naming an inherited property (`constructor`, `__proto__`) finds no parser.
 */
const SELECTORS: ReadonlyMap<string, Parse> = new Map<string, Parse>([
  [
    'FragmentSelector',
    (sent, width) => {
      const value = sent['value'];
      if (
        !onlyKeys(sent, ['type', 'conformsTo', 'value']) ||
        sent['conformsTo'] !== MEDIA_FRAGMENTS
      ) {
        return null;
      }
      const [x = -1, y = -1, w = 0, h = 0] =
        typeof value === 'string' ? (XYWH.exec(value) ?? []).slice(1).map(Number) : [];
      const inside = x >= 0 && y >= 0 && w >= 1 && h >= 1 && x + w <= width;
      return inside && y + h <= MOST_CAPTURE_HEIGHT && typeof value === 'string'
        ? { type: 'FragmentSelector', conformsTo: MEDIA_FRAGMENTS, value }
        : null;
    },
  ],
  [
    'TextQuoteSelector',
    (sent) => {
      const { exact, prefix, suffix } = sent;
      const context = (part: unknown) => part === undefined || text(part, 0, MOST_QUOTE_CONTEXT);
      const formed = onlyKeys(sent, ['type', 'exact', 'prefix', 'suffix']);
      if (!formed || !text(exact, 1, MOST_QUOTE) || !context(prefix) || !context(suffix))
        return null;
      return {
        type: 'TextQuoteSelector',
        exact,
        ...(typeof prefix === 'string' ? { prefix } : {}),
        ...(typeof suffix === 'string' ? { suffix } : {}),
      };
    },
  ],
]);

const isRecord = (value: unknown): value is Sent =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** One parsed selector per item, each type once and a fragment among them, or null. */
function selectorsOf(sent: unknown, width: CaptureWidth): readonly Selector[] | null {
  if (!Array.isArray(sent) || sent.length === 0 || sent.length > MOST_SELECTORS) return null;
  const parsed = (sent as readonly unknown[]).map((item) => {
    if (!isRecord(item) || typeof item['type'] !== 'string') return null;
    return SELECTORS.get(item['type'])?.(item, width) ?? null;
  });
  const kept = parsed.filter((selector) => selector !== null);
  const types = kept.map((selector) => selector.type);
  const whole = kept.length === parsed.length && new Set(types).size === types.length;
  return whole && types.includes('FragmentSelector') ? kept : null;
}

/**
 * The anchor `review.pin_comment` was sent, or the operand it refuses. Only the revision, the
 * width and the selectors are read; a `source` or anything else the caller adds is not kept.
 */
export function parseAnchor(sent: Sent): AnchorParse {
  const { revisionId, width } = sent;
  if (typeof revisionId !== 'string' || !isUuid(revisionId)) {
    return { ok: false, names: ['revisionId'] };
  }
  if (!CAPTURE_WIDTHS.includes(width as CaptureWidth)) return { ok: false, names: ['width'] };
  const selector = selectorsOf(sent['selector'], width as CaptureWidth);
  if (selector === null) return { ok: false, names: ['selector'] };
  return {
    ok: true,
    anchor: { source: revisionId.toLowerCase(), width: width as CaptureWidth, selector },
  };
}
