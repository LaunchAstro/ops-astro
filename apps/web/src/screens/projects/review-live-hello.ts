// SPDX-License-Identifier: AGPL-3.0-only
export function liveFrameAddress(_pageUrl: string, _productOrigin: string): URL | undefined {
  return undefined;
}
export function freshNonce(): string {
  return '';
}
export function awaitHello(_options: {
  readonly frame: HTMLIFrameElement;
  readonly siteOrigin: string;
  readonly nonce: string;
  readonly onLive: () => void;
  readonly onExpired: () => void;
}): () => void {
  return () => {};
}
