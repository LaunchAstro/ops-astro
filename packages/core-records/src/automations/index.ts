// SPDX-License-Identifier: AGPL-3.0-only
//
// Automations' way into the records package (C33): definitions, released
// versions, activations, occurrences and the registry read. The package's
// index re-exports this list whole; what the modules share with each other
// (the activation columns and row mapper) is not exported.

export {
  changeActivation,
  insertActivation,
  insertDefinition,
  readActivation,
  readVersion,
  releaseVersion,
  type ActivationMode,
  type ActivationRow,
  type ActivationSetting,
  type DefinitionKind,
  type DefinitionVersionRow,
  type VersionRelease,
} from './automations.ts';
export {
  claimOccurrence,
  type OccurrenceCause,
  type OccurrenceClaim,
  type OccurrenceOutcome,
  type OccurrenceRow,
} from './occurrences.ts';
export {
  listRegistry,
  type Registry,
  type RegistryActivation,
  type RegistryDefinition,
  type RegistryVersion,
} from './registry.ts';
