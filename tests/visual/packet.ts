// SPDX-License-Identifier: AGPL-3.0-only
// Red stub (T4c): the pins land in the next commit.

import type { Tolerance } from './compare.ts';

export type Renderer = Record<string, string | number>;
export type Packet = {
  mockup: { commit: string; tree: string };
  renderer: Renderer;
  tolerance: Tolerance;
  widths: number[];
  themes: Record<string, string>;
};
export const assetsDir: string = new URL('assets', import.meta.url).pathname;

export function readPacket(): Packet {
  throw new Error('not built');
}
export function checkRenderer(_packet: Packet, _live: Renderer): void {
  throw new Error('not built');
}
export function checkMockupTree(_dir: string, _pin: Packet['mockup']): string {
  throw new Error('not built');
}
export function checkAssets(_packet: Packet, _manifest?: unknown): void {
  throw new Error('not built');
}
