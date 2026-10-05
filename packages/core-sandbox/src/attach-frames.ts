// SPDX-License-Identifier: AGPL-3.0-only
export type AttachEnd =
  | {
      readonly ok: true;
      readonly stdout: Uint8Array;
      readonly stderr: Uint8Array;
      readonly stderrDiscarded: number;
    }
  | { readonly ok: false; readonly reason: 'output refused' | 'internal'; readonly why: string };
export class AttachFrames {
  readonly stdoutCap: number;
  constructor(stdoutCap: number) {
    this.stdoutCap = stdoutCap;
  }
  push(..._chunks: readonly Uint8Array[]): void {}
  end(): AttachEnd {
    return { ok: true, stdout: new Uint8Array(), stderr: new Uint8Array(), stderrDiscarded: 0 };
  }
}
