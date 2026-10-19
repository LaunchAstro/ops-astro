// SPDX-License-Identifier: AGPL-3.0-only
//
// U89's MP4 probe (#2039, C73): what a review render says about itself, read
// from its boxes (ISO/IEC 14496-12) and never decoded. The top-level boxes are
// walked by their headers alone, so a render whose `moov` sits after its
// `mdat` costs one more bounded read, not the whole file. From the video
// track: its sample entry's codec, its media timescale and duration, and its
// frame rate from the sample table's commonest delta, as an exact rational.
// From a timecode track (`tmcd`, QuickTime's), where there is one: its first
// sample's frame number, written as a timecode (`;` before the frames when it
// counts drop-frame); else zero. Anything malformed or past a bound reads as
// no probe at all.

export interface MediaProbe {
  /** The video sample entry's four-character code, such as `avc1` or `hvc1`. */
  readonly codec: string;
  readonly fps: { readonly num: number; readonly den: number };
  /** `HH:MM:SS:FF`, or `HH:MM:SS;FF` when drop-frame. */
  readonly startTimecode: string;
  /** The video track's duration in its own timescale. */
  readonly duration: number;
  readonly timescale: number;
}

type Read = (from: number, length: number) => Promise<Uint8Array>;

const MOST_TOP_BOXES = 64;
const MOST_MOOV_BYTES = 8 * 1024 * 1024;

interface Box {
  readonly type: string;
  /** The payload: the box less its header. */
  readonly body: Uint8Array;
}

const fourcc = (bytes: Uint8Array, at: number): string =>
  String.fromCodePoint(...bytes.subarray(at, at + 4));

const view = (bytes: Uint8Array): DataView =>
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

class Malformed extends Error {}

const u32 = (bytes: Uint8Array, at: number): number => {
  if (at + 4 > bytes.byteLength) throw new Malformed();
  return view(bytes).getUint32(at);
};

const u64 = (bytes: Uint8Array, at: number): number => {
  if (at + 8 > bytes.byteLength) throw new Malformed();
  const value = view(bytes).getBigUint64(at);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Malformed();
  return Number(value);
};

/** The child boxes of a payload, each bounded by it. */
function childrenOf(body: Uint8Array): Box[] {
  const boxes: Box[] = [];
  let at = 0;
  while (at + 8 <= body.byteLength) {
    let size = u32(body, at);
    let header = 8;
    if (size === 1) {
      size = u64(body, at + 8);
      header = 16;
    } else if (size === 0) size = body.byteLength - at;
    if (size < header || at + size > body.byteLength) throw new Malformed();
    boxes.push({ type: fourcc(body, at + 4), body: body.subarray(at + header, at + size) });
    at += size;
  }
  return boxes;
}

const child = (body: Uint8Array, ...path: string[]): Uint8Array | undefined => {
  let here: Uint8Array | undefined = body;
  for (const type of path) here = here && childrenOf(here).find((box) => box.type === type)?.body;
  return here;
};

/** The `moov` box's payload, found by walking the top-level headers. */
async function moovOf(read: Read, byteCount: number): Promise<Uint8Array> {
  let at = 0;
  for (let walked = 0; walked < MOST_TOP_BOXES && at + 8 <= byteCount; walked += 1) {
    // oxlint-disable-next-line no-await-in-loop -- each header names where the next box starts
    const header = await read(at, 16);
    let size = u32(header, 0);
    let length = 8;
    if (size === 1) {
      size = u64(header, 8);
      length = 16;
    } else if (size === 0) size = byteCount - at;
    if (size < length || at + size > byteCount) throw new Malformed();
    if (fourcc(header, 4) === 'moov') {
      if (size > MOST_MOOV_BYTES) throw new Malformed();
      // oxlint-disable-next-line no-await-in-loop -- the walk ends here
      return await readWhole(read, at + length, size - length);
    }
    at += size;
  }
  throw new Malformed();
}

async function readWhole(read: Read, from: number, length: number): Promise<Uint8Array> {
  const whole = new Uint8Array(length);
  for (let done = 0; done < length;) {
    // oxlint-disable-next-line no-await-in-loop -- each range starts where the last one ended
    const piece = await read(from + done, length - done);
    if (piece.byteLength === 0) throw new Malformed();
    whole.set(piece, done);
    done += piece.byteLength;
  }
  return whole;
}

/** A track's handler type, timescale, duration and sample table. */
function trackOf(trak: Uint8Array) {
  const mdia = child(trak, 'mdia');
  const hdlr = mdia && child(mdia, 'hdlr');
  const mdhd = mdia && child(mdia, 'mdhd');
  const stbl = mdia && child(mdia, 'minf', 'stbl');
  if (hdlr === undefined || mdhd === undefined || stbl === undefined) return null;
  const v1 = mdhd[0] === 1;
  return {
    handler: fourcc(hdlr, 8),
    timescale: u32(mdhd, v1 ? 20 : 12),
    duration: v1 ? u64(mdhd, 24) : u32(mdhd, 16),
    stbl,
  };
}

/** The sample description's first entry: its code and its payload after the size and code. */
function firstEntry(stbl: Uint8Array): { readonly code: string; readonly body: Uint8Array } {
  const stsd = child(stbl, 'stsd');
  if (stsd === undefined || u32(stsd, 4) < 1) throw new Malformed();
  const [entry] = childrenOf(stsd.subarray(8));
  if (entry === undefined) throw new Malformed();
  return { code: entry.type, body: entry.body };
}

/** The commonest sample delta of a time-to-sample table. */
function commonestDelta(stbl: Uint8Array): number {
  const stts = child(stbl, 'stts');
  if (stts === undefined) throw new Malformed();
  let best = { count: 0, delta: 0 };
  const count = u32(stts, 4);
  for (let index = 0; index < count; index += 1) {
    const entry = { count: u32(stts, 8 + index * 8), delta: u32(stts, 12 + index * 8) };
    if (entry.count > best.count) best = entry;
  }
  if (best.delta === 0) throw new Malformed();
  return best.delta;
}

const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));

const two = (value: number): string => String(value).padStart(2, '0');

/** A frame number as a timecode at a nominal rate, counting drop-frame when asked. */
export function timecodeOf(frame: number, nominal: number, dropFrame: boolean): string {
  let frames = frame;
  if (dropFrame) {
    const dropped = Math.round(nominal / 15);
    const perMinute = nominal * 60 - dropped;
    const perTen = perMinute * 10 + dropped;
    const tens = Math.floor(frames / perTen);
    const rest = frames % perTen;
    frames +=
      dropped * 9 * tens +
      (rest < dropped ? 0 : dropped * Math.floor((rest - dropped) / perMinute));
  }
  const hours = Math.floor(frames / (nominal * 3600));
  const minutes = Math.floor(frames / (nominal * 60)) % 60;
  const seconds = Math.floor(frames / nominal) % 60;
  return `${two(hours)}:${two(minutes)}:${two(seconds)}${dropFrame ? ';' : ':'}${two(frames % nominal)}`;
}

/** The timecode track's start, read from its first sample at the chunk offset its table names. */
async function startOf(read: Read, stbl: Uint8Array): Promise<string> {
  const entry = firstEntry(stbl);
  if (entry.code !== 'tmcd') throw new Malformed();
  // reserved (6), data reference (2), reserved (4), flags (4), timescale (4), frame duration
  // (4), frames per second (1); flag 1 is drop-frame.
  const dropFrame = (u32(entry.body, 12) & 1) === 1;
  const nominal = entry.body[24] ?? 0;
  const stco = child(stbl, 'stco');
  const co64 = child(stbl, 'co64');
  const offset = stco ? u32(stco, 8) : co64 ? u64(co64, 8) : undefined;
  if (nominal === 0 || offset === undefined) throw new Malformed();
  return timecodeOf(u32(await read(offset, 4), 0), nominal, dropFrame);
}

/** The probe of an MP4 read through `read`, or undefined when it cannot be read. */
export async function probeMp4(read: Read, byteCount: number): Promise<MediaProbe | undefined> {
  try {
    const tracks = childrenOf(await moovOf(read, byteCount))
      .filter((box) => box.type === 'trak')
      .map((box) => trackOf(box.body))
      .filter((track) => track !== null);
    const video = tracks.find((track) => track.handler === 'vide');
    if (video === undefined || video.timescale === 0) return undefined;
    const delta = commonestDelta(video.stbl);
    const divisor = gcd(video.timescale, delta);
    const timecode = tracks.find((track) => track.handler === 'tmcd');
    return {
      codec: firstEntry(video.stbl).code,
      fps: { num: video.timescale / divisor, den: delta / divisor },
      startTimecode: timecode === undefined ? '00:00:00:00' : await startOf(read, timecode.stbl),
      duration: video.duration,
      timescale: video.timescale,
    };
  } catch (error) {
    if (error instanceof Malformed) return undefined;
    throw error;
  }
}
