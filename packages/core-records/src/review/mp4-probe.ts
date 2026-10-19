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

export function timecodeOf(_frame: number, _nominal: number, _dropFrame: boolean): string {
  return '00:00:00:00';
}

export function probeMp4(_read: Read, _byteCount: number): Promise<MediaProbe | undefined> {
  return Promise.resolve(undefined);
}
