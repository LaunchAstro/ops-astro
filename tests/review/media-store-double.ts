// SPDX-License-Identifier: AGPL-3.0-only
//
// A stand-in for R2's multipart API behind the storage seam (U89, #2038). It
// opens, lists, completes, aborts and removes as R2 does, signs part URLs
// with its own credential, and checks each sent part as R2 checks it: the
// signature recomputed over the method and URL it was sent, then the URL's
// life against the stand-in's clock. Nothing here reaches a network.

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

export type Sent = { readonly status: 200 } | { readonly status: 403 | 404; readonly why: string };

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
    const joined = Buffer.concat(bodies as Uint8Array[]);
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

  /** A caller's PUT of one part's bytes to a URL the store signed, checked as R2 checks it. */
  send(method: 'PUT' | 'GET', sent: string, body: Uint8Array): Sent {
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
    const upload = this.#upload(key, url.searchParams.get('uploadId') ?? '');
    if (method !== 'PUT' || upload === undefined) return { status: 404, why: 'no such upload' };
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
