// SPDX-License-Identifier: AGPL-3.0-only
//
// The media store's signed transfers (U89, #2038): an S3-compatible query
// signature (SigV4, `node:crypto`, no SDK), as R2 checks it. A URL is signed
// for one bucket, one object key, one method and its query (the upload and
// part number), and carries its own start and life, so another object,
// another method, another part or a late use fails the store's check. The
// URL names the access key id and never the secret; whoever holds a
// `TransferCredential` signs, and in production that is custody alone. The
// store recomputes `transferSignature` over what it was sent.

import { createHash, createHmac } from 'node:crypto';

export interface TransferCredential {
  /** The store's origin, `https://<account>.r2.cloudflarestorage.com` for R2. */
  readonly endpoint: string;
  readonly bucket: string;
  readonly region: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
}

export interface TransferRequest {
  readonly method: 'PUT' | 'GET';
  readonly key: string;
  /** The operation's own query, such as `partNumber` and `uploadId`. */
  readonly query: Readonly<Record<string, string>>;
  readonly at: Date;
  readonly lifeSeconds: number;
}

const ALGORITHM = 'AWS4-HMAC-SHA256';
export const SIGNATURE = 'X-Amz-Signature';

const hex = (data: string): string => createHash('sha256').update(data).digest('hex');
const hmac = (key: Buffer | string, data: string): Buffer =>
  createHmac('sha256', key).update(data).digest();

/** RFC 3986 encoding, as SigV4 canonicalises a query. */
const encoded = (value: string): string =>
  encodeURIComponent(value).replaceAll(
    /[!'()*]/gu,
    (c) => `%${(c.codePointAt(0) ?? 0).toString(16).toUpperCase()}`,
  );

const stamp = (at: Date): string => at.toISOString().replaceAll(/[-:]/gu, '').replace(/\.\d+/u, '');

const scopeOf = (amzDate: string, region: string): string =>
  `${amzDate.slice(0, 8)}/${region}/s3/aws4_request`;

/** The signature over a URL and method, every query parameter but the signature included. */
export function transferSignature(
  credential: TransferCredential,
  method: string,
  url: URL,
): string {
  const query = [...url.searchParams.entries()]
    .filter(([name]) => name !== SIGNATURE)
    .map(([name, value]) => `${encoded(name)}=${encoded(value)}`)
    .toSorted()
    .join('&');
  const canonical = [method, url.pathname, query, `host:${url.host}\n`, 'host', 'UNSIGNED-PAYLOAD'];
  const amzDate = url.searchParams.get('X-Amz-Date') ?? '';
  const scope = scopeOf(amzDate, credential.region);
  const toSign = [ALGORITHM, amzDate, scope, hex(canonical.join('\n'))].join('\n');
  const dated = hmac(`AWS4${credential.secretAccessKey}`, amzDate.slice(0, 8));
  const signing = hmac(hmac(hmac(dated, credential.region), 's3'), 'aws4_request');
  return hmac(signing, toSign).toString('hex');
}

/** The path a key is signed at: the bucket, then each segment of the key. */
export const objectPath = (credential: TransferCredential, key: string): string =>
  `/${encoded(credential.bucket)}/${key
    .split('/')
    .map((segment) => encoded(segment))
    .join('/')}`;

/** A URL signed for this one request; it names the access key id, never the secret. */
export function signTransfer(credential: TransferCredential, request: TransferRequest): string {
  const url = new URL(objectPath(credential, request.key), credential.endpoint);
  const amzDate = stamp(request.at);
  for (const [name, value] of Object.entries(request.query)) url.searchParams.set(name, value);
  url.searchParams.set('X-Amz-Algorithm', ALGORITHM);
  url.searchParams.set(
    'X-Amz-Credential',
    `${credential.accessKeyId}/${scopeOf(amzDate, credential.region)}`,
  );
  url.searchParams.set('X-Amz-Date', amzDate);
  url.searchParams.set('X-Amz-Expires', String(request.lifeSeconds));
  url.searchParams.set('X-Amz-SignedHeaders', 'host');
  url.searchParams.set(SIGNATURE, transferSignature(credential, request.method, url));
  return url.toString();
}
