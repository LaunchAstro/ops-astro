# Verifiable capability map

Every product capability must be discoverable through one machine-readable map. This foundation defines the contract. The first product transfer introduces the registry implementation and its build checks.

## Declare each capability once

The map covers surfaces, tables, jobs, gates, connectors, providers, skills and exported UI components. Internal helper functions do not each require a prose entry.

Each capability has one typed registration that identifies its stable ID, kind, implementation, owning module, contract and verification references. UI registrations also identify supported variants. Build one complete map from those declarations and generate human-readable navigation from it. Do not maintain a separate manual inventory of the same facts.

Define the exact schema with the first transfer. Keep the fields to facts that a developer, agent or check needs. Runtime task values, credentials, approval decisions and execution state do not belong in this map.

## Enforce completeness independently

TypeScript validates the declarations and references it can see. A separate build check must discover the relevant exported code/schema/tool definitions and compare them with the map. A valid declared entry does not prove that no unregistered capability exists elsewhere.

Reject missing registrations, duplicate IDs, broken implementation references and missing verification references. Test both directions: an implementation absent from the registry and a registry entry absent from the implementation must fail. Run the checks again in CI; a local hook alone does not enforce them.

The first transfer must demonstrate a valid registration passing, then deliberate orphan, duplicate and stale entries failing. A generated index is not evidence that the capability works; its referenced behaviour tests and runtime evidence supply that proof.

## Keep authority clear

The registry identifies capability definitions. Code implements behaviour. Specifications record the intended outcome. Tests and direct verification establish whether the implementation meets it. Operational records and approval history remain in the database.

Do not mark a capability operational by hand just because an entry or file exists. Runtime availability follows the actual implementation, configuration and relevant verified state. Views and traces must not invent missing evidence.

## Reproducible agent context

A fresh development agent must be able to find the work through repository instructions, the current ticket/specification, the capability map and evidence. Private conversation memory cannot supply an unstated requirement.

Keep comments for non-obvious reasons or constraints and concise documents for intent and decisions that code cannot express. Derive reference lists from code where possible. Fresh-context development does not erase application knowledge or task state; a restarted worker resumes from persisted operational records.
