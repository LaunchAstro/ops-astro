// SPDX-License-Identifier: AGPL-3.0-only
//
// A conversation's text cut to a stored limit: a default title from a long
// subject, a wrap-up's quotation of a long first message.

/** `text` within `limit` code units, cut with an ellipsis between whole characters. */
export const cutWithEllipsis = (text: string, limit: number): string =>
  text.length <= limit ? text : `${text.slice(0, limit - 1).replace(/[\uD800-\uDBFF]$/u, '')}…`;
