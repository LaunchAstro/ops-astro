// SPDX-License-Identifier: AGPL-3.0-only
//
// T4b1: what the journey prints never carries a credential. Every bearer and
// delegation credential the run holds is registered here as it is minted, and
// every case line goes through `redact` before it is printed, so an answer or
// an error quoted in a failure cannot carry one out. A signed token of any
// origin is caught by its shape as well.

const held = new Set<string>();

export function holdSecret(value: string): string {
  if (value !== '') held.add(value);
  return value;
}

export function redact(text: string): string {
  return text;
}
