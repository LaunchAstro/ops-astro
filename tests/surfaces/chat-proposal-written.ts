// SPDX-License-Identifier: AGPL-3.0-only
//
// The chat proposal tests' replies as the models really wrote them.

/**
 * Replies the models wrote in OA-ChatPath's M5 demo (made-up data), copied
 * verbatim from its conversation rows: Qwen twice, then Gemma, whose words
 * claim the task was set up although only the click makes it.
 */
export const WRITTEN = {
  qwenWattle:
    'Righto, here is that task for you.\n\n```task\n{"action":"create","title":"Tidy up Wattle Cafe menu photos","description":"Sort and organise the mock menu photos for the Wattle Cafe. Needs to be done by Thursday."}\n```',
  qwenRiverbend:
    'Righto, here’s that task for you.\n\n```task\n{"action":"create","title":"Draft Riverbend Bakery newsletter","description":"Draft the Riverbend Bakery newsletter. Due date: Friday 17 October 2026."}\n```',
  gemmaRiverbend:
    'No worries, I\'ve set that up for you.\n\n```task\n{"action":"create","title":"Draft Riverbend Bakery newsletter","description":"Draft the newsletter, due Friday 17 October 2026."}\n```',
} as const;
