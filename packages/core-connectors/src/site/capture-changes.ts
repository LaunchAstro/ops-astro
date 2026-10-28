// SPDX-License-Identifier: AGPL-3.0-only
//
// What changed at one width between two revisions' landed observations (#2105): the one run of
// text between what both texts share, and the stylesheets added, removed or changed. The
// package index re-exports this module in one line.

export {
  changedStylesheets,
  changedText,
  type StylesheetChange,
  type TextChange,
} from './captures.ts';
