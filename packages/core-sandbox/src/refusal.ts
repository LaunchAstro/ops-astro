// SPDX-License-Identifier: AGPL-3.0-only
export type Why = string;
export type Refused = {
  readonly ok: false;
  readonly reason: 'proxy refused' | 'internal';
  readonly why: Why;
};
export type Result<T> = ({ readonly ok: true } & T) | Refused;
