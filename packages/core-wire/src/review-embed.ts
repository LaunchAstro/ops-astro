// SPDX-License-Identifier: AGPL-3.0-only
export const REVIEW_EMBED_PATH = '/api/public/review-embed.js';
export const LIVE_HELLO_MS = 3000;
export const LIVE_PROTOCOL = {
  version: 1,
  ping: 'ops-astro.review.ping',
  hello: 'ops-astro.review.hello',
} as const;
export function liveMessage(_data: unknown, _kind: 'ping' | 'hello'): string | undefined {
  return undefined;
}
export function reviewEmbedSnippet(_productOrigin: string): { script: string; header: string } {
  return { script: '', header: '' };
}
