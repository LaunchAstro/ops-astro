# Superseded: engineer approval for eight protected components

Accepted 6 September 2026. **Superseded 10 September 2026**: the senior
engineer engagement and its stop authority were withdrawn before any
engineer was engaged. Replaced by a green conformance proof per protected
component, as a required check, which Nathan accepts before the change
merges.

This record keeps its number and its filename so that references to it still
resolve. It is superseded, not erased.

## What it said

Written approval and stop authority over the domain model, tenancy wrapper,
queue and delivery contracts, gate engine, credential broker, egress control,
sandbox launcher, and migration system sat with a senior engineer, and a
change to any of those components waited for that written approval before
merge.

## What replaced it

A change to one of those eight components requires that the component's
conformance test be green, as a required check. It is a check rather than a
person, so a review cannot waive it, no one can argue it away, and nobody's
absence can hold it up.

The eight components are unchanged, and so is the reason they are protected:
review requirements should exist before product implementation makes the
changes expensive to reverse. Nathan's merge checklist, model review and
Copilot do not replace the conformance proof, and it does not replace them.

The sandbox keeps its additional
[before-implementation contract hold](0048-sandbox-launcher-contract-drafted-reviewed-not-built.md),
which is now Nathan's to give.

No engineer was ever engaged, and this foundation never claimed one was.
