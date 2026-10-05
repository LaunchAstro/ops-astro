// SPDX-License-Identifier: AGPL-3.0-only
//
// The attach stream (docs/plan/sandbox-contract.md, the preamble): read only
// as Docker's multiplexed frames, each an 8-byte header (stream byte, three
// zero bytes, a big-endian length) and its payload, of stream 1 (stdout) or
// 2 (stderr). Any other stream, a non-zero reserved byte, or a stream that
// ends inside a frame is a daemon fault (`internal`). Stdout past its class's
// cap is `output refused`; stderr past 64 KiB is discarded, never refused.
// Once refused, the reader keeps that refusal and reads nothing more.
//
// Stdout is kept in fixed 1 MiB blocks and handed back as those blocks, so
// memory follows the bytes kept, never the number of frames, and nothing is
// copied twice.

import type { Why } from './refusal.ts';

export const STDERR_KEPT: number = 64 * 1024;
const BLOCK = 1024 * 1024;

export type AttachEnd =
  | {
      readonly ok: true;
      /** Stdout in order, as blocks of at most 1 MiB. */
      readonly stdout: readonly Uint8Array[];
      readonly stderr: Uint8Array;
      readonly stderrDiscarded: number;
    }
  | { readonly ok: false; readonly reason: 'output refused' | 'internal'; readonly why: Why };

export class AttachFrames {
  readonly stdoutCap: number;
  private readonly header = new Uint8Array(8);
  private headerFill = 0;
  private stream = 0;
  private left = 0;
  private readonly blocks: Uint8Array[] = [];
  private blockFill = BLOCK;
  private stdoutBytes = 0;
  private readonly stderr = new Uint8Array(STDERR_KEPT);
  private stderrBytes = 0;
  private discarded = 0;
  private refused: AttachEnd | null = null;

  constructor(stdoutCap: number) {
    this.stdoutCap = stdoutCap;
  }

  push(...chunks: readonly Uint8Array[]): void {
    for (const chunk of chunks) this.read(chunk);
  }

  private read(chunk: Uint8Array): void {
    let at = 0;
    while (at < chunk.length && this.refused === null) {
      if (this.left === 0 && this.headerFill < 8) {
        const take = Math.min(8 - this.headerFill, chunk.length - at);
        this.header.set(chunk.subarray(at, at + take), this.headerFill);
        this.headerFill += take;
        at += take;
        if (this.headerFill === 8) this.startFrame();
        continue;
      }
      const take = Math.min(this.left, chunk.length - at);
      this.keep(chunk.subarray(at, at + take));
      this.left -= take;
      at += take;
      if (this.left === 0) this.headerFill = 0;
    }
  }

  private startFrame(): void {
    const [stream, a, b, c] = this.header;
    if ((stream !== 1 && stream !== 2) || a !== 0 || b !== 0 || c !== 0) {
      this.refused = { ok: false, reason: 'internal', why: 'reply body' };
      return;
    }
    this.stream = stream;
    this.left = new DataView(this.header.buffer).getUint32(4);
    if (this.left === 0) this.headerFill = 0;
  }

  private keep(bytes: Uint8Array): void {
    if (this.stream === 1) {
      this.stdoutBytes += bytes.length;
      if (this.stdoutBytes > this.stdoutCap) {
        this.refused = { ok: false, reason: 'output refused', why: 'too large' };
        return;
      }
      this.keepStdout(bytes);
      return;
    }
    const kept = Math.min(STDERR_KEPT - this.stderrBytes, bytes.length);
    this.stderr.set(bytes.subarray(0, kept), this.stderrBytes);
    this.stderrBytes += kept;
    this.discarded += bytes.length - kept;
  }

  private keepStdout(bytes: Uint8Array): void {
    let at = 0;
    while (at < bytes.length) {
      if (this.blockFill === BLOCK) {
        this.blocks.push(new Uint8Array(BLOCK));
        this.blockFill = 0;
      }
      const take = Math.min(BLOCK - this.blockFill, bytes.length - at);
      this.blocks.at(-1)?.set(bytes.subarray(at, at + take), this.blockFill);
      this.blockFill += take;
      at += take;
    }
  }

  end(): AttachEnd {
    if (this.refused !== null) return this.refused;
    if (this.headerFill !== 0 || this.left !== 0) {
      return { ok: false, reason: 'internal', why: 'reply body' };
    }
    return {
      ok: true,
      stdout: this.blocks.map((block, index) =>
        index === this.blocks.length - 1 ? block.subarray(0, this.blockFill) : block,
      ),
      stderr: this.stderr.subarray(0, this.stderrBytes),
      stderrDiscarded: this.discarded,
    };
  }
}
