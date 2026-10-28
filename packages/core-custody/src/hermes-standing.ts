// SPDX-License-Identifier: AGPL-3.0-only
//
// Hermes Agent's standing (#2270). Its conversation operation answers only a
// person `OPS_HERMES_PEOPLE` lists, in their own session with no delegation:
// the owner's own chats, as his decision of 28 October 2026 allows. A run's
// `model.call` never names it, whoever started the run, so no task text and
// no unattended work reaches an agent that acts on the M5. It imports no
// connector code, as `outside-carriage.ts` imports none.

/** Hermes Agent's provider key (`HERMES_PROVIDER` in core-connectors); a test holds the two equal. */
export const HERMES_PROVIDER_KEY = 'hermes';

/** An operation a run may name: never Hermes Agent's. */
export const answersRuns = (operation: { readonly provider: string }): boolean =>
  operation.provider !== HERMES_PROVIDER_KEY;

/** The caller is listed for this business, present in their own session, with no delegation. */
export function hermesStanding(
  broker: { readonly hermesPeople?: readonly string[] },
  businessId: string,
  caller: { readonly delegationId: string | null; readonly attendedByPersonId: string | null },
): boolean {
  const person = caller.attendedByPersonId;
  if (person === null || caller.delegationId !== null) return false;
  const pair = `${businessId}:${person}`.toLowerCase();
  return (broker.hermesPeople ?? []).some((listed) => listed.toLowerCase() === pair);
}
