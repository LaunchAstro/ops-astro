# Model roles and development context

[AGENTS.md](../../AGENTS.md) declares the Matt Pocock loop as the only router.
Pstack supplies selected standards inside that workflow.

| Role                       | Responsibility                                                                                                                                 |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Planner                    | Resolve open requirements and prepare the specification and proposed ticket boundaries.                                                        |
| Builder                    | Own one ticket, isolated worktree, and branch. Produce implementation and evidence.                                                            |
| Independent model reviewer | A frontier model from a different company than the builder's, in fresh context. Inspect the exact files, diff, specification, and boundaries.  |
| Security reviewer          | Review sensitive changes before their pull request under the repository's security procedure.                                                  |
| Copilot                    | Review the actual hosted revision. Resolve each finding on its merits.                                                                         |
| Verifier                   | Exercise the integrated behaviour and inspect durable results.                                                                                 |
| Merging agent              | Invoke the merge on Nathan's credential once every required check is green on the revision, then notify him. It exercises no discretion.       |
| Nathan                     | Decide the production deploy, the five protected parts, coherence waivers, tier reductions, and the final sandbox contract before it is built. |
| Conformance proof          | The component's conformance test must be green before a change to one of the eight protected components merges. A check, not a person.         |

The builder cannot approve its own work. A model's report is not a
conformance proof. A review of a previous revision does not cover later
changes.

## Fresh context and handoff

Start each ticket in a fresh context. Load repository instructions, the
current decisions, the specification, the ticket, and current evidence.
Verify the applicable runtime memory settings. Private conversation memory
must not supply requirements or a hidden second task store. Product tasks,
knowledge, approvals, and execution records remain persistent.

A written handoff includes the ticket and acceptance criteria, the exact
revision or candidate manifest, verification commands and results, findings
with file references, and their disposition. The receiver inspects the actual
artefact. An earlier agent's assurance does not replace that inspection.

A handback that reports a bug or hands over evidence carries seven things, and
a report missing any of them costs the receiver the work of reconstructing it:

1. **The exact head**, plus the dirty diff or a manifest of it. A tree nobody
   can reconstruct is a report about nothing.
2. **The command**, as run, including the environment it needed.
3. **The failing case or refusal**, named: the case identifier, the refusal
   code, or the assertion.
4. **Expected against actual**, both stated, rather than one and an adjective.
5. **The relevant logs, with secrets removed.** Generated passwords, service
   secrets and signing keys never travel in a report.
6. **Where the evidence is**, as a path the receiver can open.
7. **What remains uncertain**, said plainly. An unresolved question stated is
   worth more than a confident summary that hides it.

Distinguish three claims throughout, because collapsing them is how a tree
comes to look more finished than it is: **implemented** means the mechanism is
in the tree; **tested** names the command that exercises it; **accepted** means
a review record says so, and nothing else does.
[The local slice](../local/README.md#reporting-a-bug-or-handing-back-evidence)
points here rather than keeping a second copy of this list.

Keep comments for non-obvious reasons and constraints. Keep intent and durable
decisions in concise prose. The capability registry generates navigation when
implemented; do not maintain a competing manual inventory.

## Scope and evidence

Complete authorised reversible work. Spending, outward messages, destructive
actions, production changes, and publication require the applicable explicit
authority. A local preparation approval does not authorise those actions.

No model calls run in CI under this foundation. Any later API-based evaluation
requires an approved budget and credential arrangement. Local tooling tests,
independent model review, Copilot review, and conformance proofs are
separate forms of evidence.
