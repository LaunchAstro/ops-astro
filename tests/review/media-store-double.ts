// SPDX-License-Identifier: AGPL-3.0-only
//
// A stand-in for R2's multipart API behind the storage seam (U89, #2038). It
// opens, lists, completes, aborts and removes as R2 does, signs part URLs
// with its own credential, and checks each sent part as R2 checks it: the
// signature recomputed over the method and URL it was sent, then the URL's
// life against the stand-in's clock. A range read (#2039) is a GET the
// stand-in signs for one object and checks the same way; a test can make the
// stand-in answer it with other bytes than asked. Nothing here reaches a
// network.

import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import type {
  ObjectTransfers,
  SignedTransfer,
  StoredPart,
  TransferCredential,
  TransferRefusal,
} from '../../packages/core-records/src/index.ts';
import {
  objectPath,
  SIGNATURE,
  signTransfer,
  transferSignature,
} from '../../packages/core-records/src/index.ts';

/** Fake, and only ever in this stand-in: a marker a leak check can look for. */
export const DOUBLE_SECRET = 'media-double-secret-7f3a9c';

export const DOUBLE_CREDENTIAL: TransferCredential = {
  endpoint: 'https://media-double.invalid',
  bucket: 'review-media',
  region: 'auto',
  accessKeyId: 'media-double-key-id',
  secretAccessKey: DOUBLE_SECRET,
};

export type Sent =
  | { readonly status: 200; readonly body?: Uint8Array }
  | { readonly status: 403 | 404; readonly why: string };

/** How the stand-in answers a range read: as asked, or with one byte too many or too few. */
export type RangeAnswer = 'honest' | 'longer' | 'shorter';

export interface RangeAsked {
  readonly key: string;
  readonly from: number;
  readonly length: number;
}

const digestOf = (body: Uint8Array): string =>
  `sha256:${createHash('sha256').update(body).digest('hex')}`;

const UNKNOWN: TransferRefusal = { refused: 'UPLOAD_UNKNOWN' };
const DATED = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/u;

interface Upload {
  readonly key: string;
  readonly parts: Map<number, Uint8Array>;
}

export class MediaStoreDouble implements ObjectTransfers {
  /** Completed objects by key. */
  readonly objects: Map<string, Uint8Array> = new Map();
  /** Each port call by name, in order. */
  readonly calls: string[] = [];
  /** The stand-in's clock; a test moves it to send late. */
  readonly clock: { now: Date } = { now: new Date() };
  /** Each range read asked, in order. */
  readonly ranges: RangeAsked[] = [];
  /** How range reads are answered; a test sets it to plant a hostile store. */
  answer: RangeAnswer = 'honest';
  readonly #uploads: Map<string, Upload> = new Map();

  readonly partBytes: number;

  constructor(partBytes = 4) {
    this.partBytes = partBytes;
  }

  open(key: string): Promise<{ readonly uploadId: string }> {
    this.calls.push('open');
    const uploadId = randomUUID();
    this.#uploads.set(uploadId, { key, parts: new Map() });
    return Promise.resolve({ uploadId });
  }

  signPart(
    key: string,
    uploadId: string,
    partNumber: number,
    lifeSeconds: number,
  ): Promise<SignedTransfer | TransferRefusal> {
    this.calls.push('signPart');
    if (this.#upload(key, uploadId) === undefined) return Promise.resolve(UNKNOWN);
    const { now } = this.clock;
    const url = signTransfer(DOUBLE_CREDENTIAL, {
      method: 'PUT',
      key,
      query: { partNumber: String(partNumber), uploadId },
      at: now,
      lifeSeconds,
    });
    const expiresAt = new Date(now.getTime() + lifeSeconds * 1000).toISOString();
    return Promise.resolve({ url, method: 'PUT', expiresAt });
  }

  listParts(key: string, uploadId: string): Promise<readonly StoredPart[] | TransferRefusal> {
    this.calls.push('listParts');
    const upload = this.#upload(key, uploadId);
    if (upload === undefined) return Promise.resolve(UNKNOWN);
    const parts = [...upload.parts.entries()].map(([partNumber, body]): StoredPart => ({
      partNumber,
      byteCount: body.byteLength,
    }));
    return Promise.resolve(parts.toSorted((a, b) => a.partNumber - b.partNumber));
  }

  complete(
    key: string,
    uploadId: string,
    partNumbers: readonly number[],
  ): Promise<{ readonly byteCount: number; readonly digest: string } | TransferRefusal> {
    this.calls.push('complete');
    const upload = this.#upload(key, uploadId);
    const bodies = partNumbers.map((n) => upload?.parts.get(n));
    if (upload === undefined || bodies.includes(undefined)) return Promise.resolve(UNKNOWN);
    const joined = new Uint8Array(Buffer.concat(bodies as Uint8Array[]));
    this.#uploads.delete(uploadId);
    this.objects.set(key, joined);
    return Promise.resolve({ byteCount: joined.byteLength, digest: digestOf(joined) });
  }

  abort(key: string, uploadId: string): Promise<boolean> {
    this.calls.push('abort');
    return Promise.resolve(
      this.#upload(key, uploadId) !== undefined && this.#uploads.delete(uploadId),
    );
  }

  remove(key: string): Promise<boolean> {
    this.calls.push('remove');
    return Promise.resolve(this.objects.delete(key));
  }

  signRead(key: string, lifeSeconds: number): Promise<SignedTransfer | TransferRefusal> {
    this.calls.push('signRead');
    if (!this.objects.has(key)) return Promise.resolve(UNKNOWN);
    const { now } = this.clock;
    const url = signTransfer(DOUBLE_CREDENTIAL, {
      method: 'GET',
      key,
      query: {},
      at: now,
      lifeSeconds,
    });
    const expiresAt = new Date(now.getTime() + lifeSeconds * 1000).toISOString();
    return Promise.resolve({ url, method: 'GET', expiresAt });
  }

  /** A GET signed for the object, sent with its range and checked as any signed URL is. */
  readRange(key: string, from: number, length: number): Promise<Uint8Array | TransferRefusal> {
    this.calls.push('readRange');
    this.ranges.push({ key, from, length });
    const url = signTransfer(DOUBLE_CREDENTIAL, {
      method: 'GET',
      key,
      query: {},
      at: this.clock.now,
      lifeSeconds: 60,
    });
    const sent = this.send('GET', url, new Uint8Array(), { from, length });
    if (sent.status !== 200 || sent.body === undefined) return Promise.resolve(UNKNOWN);
    const answered = {
      honest: sent.body,
      longer: new Uint8Array([...sent.body, 0]),
      shorter: sent.body.slice(0, -1),
    }[this.answer];
    return Promise.resolve(answered);
  }

  /**
   * A caller's request to a URL the store signed, checked as R2 checks it: a PUT of one part's
   * bytes, or a GET of a completed object's range.
   */
  send(
    method: 'PUT' | 'GET',
    sent: string,
    body: Uint8Array,
    range?: { readonly from: number; readonly length: number },
  ): Sent {
    const url = new URL(sent);
    const prefix = objectPath(DOUBLE_CREDENTIAL, '');
    if (url.origin !== DOUBLE_CREDENTIAL.endpoint || !url.pathname.startsWith(prefix)) {
      return { status: 403, why: 'other store' };
    }
    const given = Buffer.from(url.searchParams.get(SIGNATURE) ?? '', 'hex');
    const expected = Buffer.from(transferSignature(DOUBLE_CREDENTIAL, method, url), 'hex');
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      return { status: 403, why: 'signature does not match' };
    }
    const at = DATED.exec(url.searchParams.get('X-Amz-Date') ?? '')
      ?.slice(1)
      .map(Number);
    if (at === undefined) return { status: 403, why: 'no date' };
    const [y = 0, mo = 1, d = 0, h = 0, mi = 0, s = 0] = at;
    const life = Number(url.searchParams.get('X-Amz-Expires'));
    if (this.clock.now.getTime() > Date.UTC(y, mo - 1, d, h, mi, s) + life * 1000) {
      return { status: 403, why: 'expired' };
    }
    const key = url.pathname
      .slice(prefix.length)
      .split('/')
      .map((segment) => decodeURIComponent(segment))
      .join('/');
    if (method === 'GET') {
      const object = this.objects.get(key);
      if (object === undefined) return { status: 404, why: 'no such object' };
      const from = range?.from ?? 0;
      return { status: 200, body: object.slice(from, from + (range?.length ?? object.byteLength)) };
    }
    const upload = this.#upload(key, url.searchParams.get('uploadId') ?? '');
    if (upload === undefined) return { status: 404, why: 'no such upload' };
    upload.parts.set(Number(url.searchParams.get('partNumber')), body);
    return { status: 200 };
  }

  #upload(key: string, uploadId: string): Upload | undefined {
    const upload = this.#uploads.get(uploadId);
    return upload?.key === key ? upload : undefined;
  }
}

export const mediaStoreDouble = (partBytes = 4): MediaStoreDouble =>
  new MediaStoreDouble(partBytes);
