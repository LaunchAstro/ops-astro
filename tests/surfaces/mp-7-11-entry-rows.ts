// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-7-11 entry <row>: the ticket's client entry rows (CS-7.37), written out
// from the ticket as an oracle independent of the register the code keeps.

/** Each client row, and the words its drafted question is about (the register's outcome). */
export const CLIENT_ROWS: readonly (readonly [row: string, about: RegExp])[] = [
  ['SI-M03', /what is behind/iu],
  ['SIR-M03', /what is behind/iu],
  ['GA-M06', /this move or the run/iu],
  ['MA-M06', /this move/iu],
  ['TS-M05', /running test/iu],
  ['LR-M03', /what is behind/iu],
  ['CL-M03', /what is behind/iu],
  ['WSH-11', /what is behind/iu],
  ['WSH-13', /what is behind/iu],
  ['TL-W01', /what is behind/iu],
  ['FM-W01', /what is behind/iu],
  ['SS-W01', /what is behind/iu],
  ['TL-M03', /what is behind/iu],
  ['SS-M03', /what is behind/iu],
  ['SS3-M03', /what is behind/iu],
  ['FM-M03', /what is behind/iu],
  ['OB-M06', /what is behind/iu],
  ['EM-M03', /what is behind/iu],
  ['FN-M03', /stage/iu],
  ['RV-M03', /attributed revenue/iu],
  ['WP-M03', /site speed/iu],
  ['WPO-M03', /site speed/iu],
];
