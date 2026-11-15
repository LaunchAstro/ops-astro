// SPDX-License-Identifier: AGPL-3.0-only
//
// Files for U89's upload contract (#2039), made in the test: small MP4s with
// a video track at a chosen frame rate and a timecode track at a chosen start
// (moov before or after mdat), a PDF, and the standard anti-malware test file
// (EICAR), joined from pieces here so no file scanner on a developer's
// machine quarantines this source. The test scan engine recognises that
// file's signature anywhere in a stream, across chunk edges.

import type { MediaScanner, ScanVerdict } from '../../packages/core-records/src/index.ts';

const encoder = new TextEncoder();

const u32 = (value: number): Uint8Array => {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value);
  return bytes;
};
const u16 = (value: number): Uint8Array => u32(value).subarray(2);

const join = (...parts: readonly Uint8Array[]): Uint8Array => {
  const whole = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
  let at = 0;
  for (const part of parts) {
    whole.set(part, at);
    at += part.byteLength;
  }
  return whole;
};

const box = (type: string, ...payload: readonly Uint8Array[]): Uint8Array => {
  const body = join(...payload);
  return join(u32(body.byteLength + 8), encoder.encode(type), body);
};

const full = (type: string, ...payload: readonly Uint8Array[]): Uint8Array =>
  box(type, u32(0), ...payload);

const zeros = (length: number): Uint8Array => new Uint8Array(length);

export interface Mp4Shape {
  readonly codec: 'avc1' | 'hvc1';
  readonly timescale: number;
  readonly delta: number;
  readonly frames: number;
  /** The timecode track's nominal frames per second, its drop-frame flag and its first frame. */
  readonly timecode?: {
    readonly nominal: number;
    readonly dropFrame: boolean;
    readonly start: number;
  };
  readonly moovAtEnd?: boolean;
  /** Bytes of picture data after the timecode sample. */
  readonly padding?: number;
}

const mdhd = (timescale: number, duration: number): Uint8Array =>
  full('mdhd', u32(0), u32(0), u32(timescale), u32(duration), u32(0));

const hdlr = (handler: string): Uint8Array =>
  full('hdlr', u32(0), encoder.encode(handler), zeros(12), zeros(1));

const trak = (handler: string, timescale: number, duration: number, stbl: Uint8Array) =>
  box('trak', box('mdia', mdhd(timescale, duration), hdlr(handler), box('minf', stbl)));

function moov(shape: Mp4Shape, sampleAt: number): Uint8Array {
  const duration = shape.frames * shape.delta;
  const video = box(
    'stbl',
    full('stsd', u32(1), box(shape.codec, zeros(78))),
    full('stts', u32(1), u32(shape.frames), u32(shape.delta)),
  );
  const tracks = [trak('vide', shape.timescale, duration, video)];
  if (shape.timecode !== undefined) {
    const { nominal, dropFrame } = shape.timecode;
    const entry = box(
      'tmcd',
      zeros(6),
      u16(1),
      zeros(4),
      u32(dropFrame ? 1 : 0),
      u32(shape.timescale),
      u32(shape.delta),
      new Uint8Array([nominal, 0]),
    );
    const stbl = box(
      'stbl',
      full('stsd', u32(1), entry),
      full('stts', u32(1), u32(1), u32(duration)),
      full('stco', u32(1), u32(sampleAt)),
    );
    tracks.push(trak('tmcd', shape.timescale, duration, stbl));
  }
  return box('moov', full('mvhd', zeros(96)), ...tracks);
}

/** An MP4 of `shape`: ftyp, then moov and mdat in the order asked. */
export function mp4Of(shape: Mp4Shape): Uint8Array {
  const ftyp = box('ftyp', encoder.encode('isom'), u32(512), encoder.encode('isomavc1'));
  const samples = join(u32(shape.timecode?.start ?? 0), zeros(shape.padding ?? 32));
  const mdatLength = samples.byteLength + 8;
  // The timecode sample is the first in mdat; its offset depends on what comes before.
  const moovLength = moov(shape, 0).byteLength;
  const sampleAt = ftyp.byteLength + 8 + (shape.moovAtEnd === true ? 0 : moovLength);
  const mdat = box('mdat', samples);
  const header = moov(shape, sampleAt);
  if (mdat.byteLength !== mdatLength) throw new Error('mp4Of: mdat length');
  return shape.moovAtEnd === true ? join(ftyp, mdat, header) : join(ftyp, header, mdat);
}

export const PDF_BYTES: Uint8Array = encoder.encode(
  '%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n',
);

/** The EICAR anti-malware test file, joined from pieces. */
export const TEST_VIRUS: Uint8Array = encoder.encode(
  ['X5O!P%@AP[4\\PZX54(P^)7CC)7}$', 'EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*'].join(''),
);

/** A PNG's signature and a little more: what an image upload's head is. */
export const PNG_BYTES: Uint8Array = join(
  new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  zeros(24),
);

const containsAt = (haystack: Uint8Array, needle: Uint8Array): boolean => {
  for (let at = 0; at + needle.byteLength <= haystack.byteLength; at += 1)
    if (needle.every((byte, index) => haystack[at + index] === byte)) return true;
  return false;
};

/** A scanner that fails a stream holding the test file's signature, across chunk edges. */
export const testScanEngine: MediaScanner = {
  engine: 'test-engine (EICAR signature)',
  async scan(chunks: AsyncIterable<Uint8Array>): Promise<ScanVerdict> {
    let carried = new Uint8Array();
    for await (const chunk of chunks) {
      const window = join(carried, chunk);
      if (containsAt(window, TEST_VIRUS)) return 'failed';
      carried = window.slice(Math.max(0, window.byteLength - TEST_VIRUS.byteLength + 1));
    }
    return 'passed';
  },
};
