// SPDX-License-Identifier: AGPL-3.0-only
//
// A made-up review for the Review workspace (C35, #2105): a page with two revisions, each
// landed at laptop and phone size, two pins on the revision under review and what changed
// between them; and the pictures, small PNGs drawn here as a page's header, headline and
// lines of text, so a capture reads as a page. Every name and address is made up.

import { crc32, deflateSync } from 'node:zlib';
import type {
  ReviewListResult,
  ReviewPictureResult,
  ReviewReadResult,
} from '../../packages/core-wire/src/index.ts';

export const REVIEW_ID = '55555555-5555-4555-8555-555555555555';
const FIRST = '55555555-5555-4555-8555-000000000001';
const SECOND = '55555555-5555-4555-8555-000000000002';
const PAGE = 'https://harbour-bikes.example/about/';
const SHEETS = { 'https://harbour-bikes.example/site.css': `sha256:${'a'.repeat(64)}` };

/** The picture of `revision` at `width`: its id names both, so the picture read can draw it. */
const pictureId = (revision: 1 | 2, width: 1480 | 390): string =>
  `66666666-6666-4666-8666-${String(revision)}${String(width).padStart(11, '0')}`;

const landed = (revision: 1 | 2, width: 1480 | 390, text: string) => ({
  width,
  state: 'landed' as const,
  pictureId: pictureId(revision, width),
  pictureDigest: `sha256:${String(revision).repeat(64)}`,
  observation: {
    url: PAGE,
    status: 200,
    documentDigest: `sha256:${'d'.repeat(64)}`,
    text,
    html: `<main><p>${text}</p></main>`,
    stylesheets: SHEETS,
  },
});

const revision = (number: 1 | 2, id: string, text: string) => ({
  revisionId: id,
  number,
  digest: `sha256:${String(number + 4).repeat(64)}`,
  captures: [landed(number, 1480, text), landed(number, 390, text)],
  decision: null,
  correctionId: null,
});

const before = revision(1, FIRST, 'Harbour Bikes fixes bikes in Townsville.');
const after = revision(2, SECOND, 'Harbour Bikes fixes e-bikes in Townsville.');

const pin = (
  commentId: string,
  width: 1480 | 390,
  value: string,
  body: string,
  audience: 'internal' | 'client',
) => ({
  commentId,
  audience,
  body,
  anchor: {
    source: SECOND,
    width,
    selector: [
      { type: 'FragmentSelector' as const, conformsTo: 'http://www.w3.org/TR/media-frags/', value },
    ],
  },
});

export const REVIEW: ReviewReadResult = {
  ok: true,
  review: {
    reviewId: REVIEW_ID,
    taskId: '77777777-7777-4777-8777-777777777777',
    partyId: '88888888-8888-4888-8888-888888888888',
    kind: 'page',
    pageUrl: PAGE,
    path: 'src/pages/about.astro',
    revisions: [before, after],
    before,
    after,
    pins: [
      pin(
        '99999999-9999-4999-8999-000000000001',
        1480,
        'xywh=120,96,520,64',
        'Say e-bikes in the headline too',
        'internal',
      ),
      pin(
        '99999999-9999-4999-8999-000000000002',
        390,
        'xywh=24,200,300,40',
        'Is this line right on phones?',
        'client',
      ),
    ],
    carried: [],
    carryDue: false,
    changeRequests: [],
    differences: [
      {
        width: 1480,
        text: { at: 20, removed: '', added: 'e-' },
        stylesheets: [
          {
            address: 'https://harbour-bikes.example/site.css',
            before: `sha256:${'a'.repeat(64)}`,
            after: `sha256:${'c'.repeat(64)}`,
          },
        ],
      },
      { width: 390, text: null, stylesheets: [] },
    ],
  },
};

const FRAGMENT = 'http://www.w3.org/TR/media-frags/';
const spot = (value: string) => ({
  type: 'FragmentSelector' as const,
  conformsTo: FRAGMENT,
  value,
});
const quote = (exact: string) => ({ type: 'TextQuoteSelector' as const, exact });

/** Three pins made on revision 1, before the page changed (#2140). */
const EARLIER = [
  {
    commentId: '99999999-9999-4999-8999-000000000011',
    audience: 'internal' as const,
    body: 'Warmer opening line, please',
    anchor: { source: FIRST, width: 1480 as const, selector: [spot('xywh=120,200,700,16')] },
  },
  {
    commentId: '99999999-9999-4999-8999-000000000012',
    audience: 'client' as const,
    body: 'Is fixes bikes still the right promise?',
    anchor: {
      source: FIRST,
      width: 1480 as const,
      selector: [spot('xywh=120,96,520,64'), quote('fixes bikes')],
    },
  },
  {
    commentId: '99999999-9999-4999-8999-000000000013',
    audience: 'internal' as const,
    body: 'Keep Townsville in this line',
    anchor: {
      source: FIRST,
      width: 390 as const,
      selector: [spot('xywh=24,200,300,40'), quote('Townsville')],
    },
  },
];

const carriedFrom = (at: number, anchor: (typeof EARLIER)[number]['anchor'] | null) => {
  const { commentId, audience, body } = EARLIER[at] ?? EARLIER[0]!;
  return { commentId, audience, body, fromRevisionId: FIRST, lost: anchor === null, anchor };
};

/**
 * The review with revision 1's pins carried onto revision 2 (#2140), lost first as the read
 * sends them: the promise's quote is gone from the new text, so it is lost; the opening line
 * is found again at its spot; Townsville is found by its text alone, with no coordinate.
 */
export const CARRIED_REVIEW: ReviewReadResult = {
  ok: true,
  review: {
    ...REVIEW.review,
    pins: [...EARLIER, ...REVIEW.review.pins],
    carried: [
      carriedFrom(1, null),
      carriedFrom(0, { source: SECOND, width: 1480, selector: [spot('xywh=120,200,700,16')] }),
      carriedFrom(2, { source: SECOND, width: 390, selector: [quote('Townsville')] }),
    ],
  },
};

/** The same review at its first revision: nothing before it and nothing changed. */
export const FIRST_REVIEW: ReviewReadResult = {
  ok: true,
  review: {
    ...REVIEW.review,
    revisions: [before],
    before: null,
    after: before,
    pins: [],
    carried: [],
    carryDue: false,
    differences: [],
  },
};

const GREY = [0xe6, 0xe8, 0xeb] as const;
const INK = [0x2b, 0x31, 0x3a] as const;
const ACCENT = [0x2f, 0x6f, 0xb3] as const;
const PAPER = [0xfb, 0xfb, 0xfa] as const;

/** One row's colour: the header band, the headline, and lines of text with a gap between. */
function rowColour(y: number, number: number): readonly [number, number, number] {
  if (y < 64) return INK;
  if (y >= 96 && y < 160) return number === 2 ? ACCENT : INK;
  if (y >= 200 && (y - 200) % 40 < 16) return GREY;
  return PAPER;
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const named = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const check = Buffer.alloc(4);
  check.writeUInt32BE(crc32(named));
  return Buffer.concat([length, named, check]);
}

/** A PNG `width` by `height` of a page at revision `number`, in base64. */
function pagePicture(width: number, height: number, number: number): string {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const rows: Buffer[] = [];
  for (let y = 0; y < height; y += 1) {
    const row = Buffer.alloc(1 + width * 3);
    const colour = rowColour(y, number);
    const margin = Math.round(width / 12);
    for (let x = margin; x < width - margin; x += 1) row.set(colour, 1 + x * 3);
    for (const x of [
      ...Array.from({ length: margin }, (_, at) => at),
      ...Array.from({ length: margin }, (_, at) => width - 1 - at),
    ]) {
      row.set(y < 64 ? INK : PAPER, 1 + x * 3);
    }
    rows.push(row);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]).toString('base64');
}

const drawn = new Map<string, string>();

/** A made-up picture, drawn once and kept. */
function picture(number: 1 | 2, width: 1480 | 390): ReviewPictureResult {
  const id = pictureId(number, width);
  const body = drawn.get(id) ?? pagePicture(width, width === 1480 ? 900 : 1200, number);
  drawn.set(id, body);
  const digest = `sha256:${String(number).repeat(64)}`;
  const byteCount = Buffer.from(body, 'base64').byteLength;
  return { ok: true, picture: { pictureId: id, digest, byteCount, body } };
}

/** `review.picture` by id: the made-up picture it names, or the laptop capture under review. */
export function pictureOf(id: unknown): ReviewPictureResult {
  for (const number of [1, 2] as const) {
    for (const width of [1480, 390] as const) {
      if (id === pictureId(number, width)) return picture(number, width);
    }
  }
  return picture(2, 1480);
}

/** The Reviews page's list: the made-up review, its second revision waiting for a decision. */
const LISTED: ReviewListResult = {
  ok: true,
  reviews: [
    {
      reviewId: REVIEW_ID,
      taskId: CARRIED_REVIEW.review.taskId,
      partyId: CARRIED_REVIEW.review.partyId,
      kind: 'page',
      pageUrl: CARRIED_REVIEW.review.pageUrl,
      path: CARRIED_REVIEW.review.path,
      revisionCount: CARRIED_REVIEW.review.revisions.length,
      openPins: CARRIED_REVIEW.review.pins.length,
      openChangeRequests: CARRIED_REVIEW.review.changeRequests.filter(
        (request) => request.state === 'proposed',
      ).length,
      latest: 'undecided',
      updatedAt: '2026-10-19T09:00:00.000Z',
    },
  ],
};

/** The reads' default answers: the review list, the review, and the laptop capture under review. */
export const REVIEW_READS: {
  readonly 'review.list': ReviewListResult;
  readonly 'review.read': ReviewReadResult;
  readonly 'review.picture': ReviewPictureResult;
} = { 'review.list': LISTED, 'review.read': CARRIED_REVIEW, 'review.picture': picture(2, 1480) };
