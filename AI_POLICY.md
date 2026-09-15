# AI policy

Nathan Mulligan directs AI-assisted work and accepts responsibility for each
merged change. A named human must understand submitted work and answer for it
in review. Local automated checks are evidence of their named tests only.
They are not a human's acceptance or a security certification.

## Commit provenance

An agent-assisted commit requires these trailers:

```text
Assisted-by: LLM
Agent-model: <actual authoring model>
Agent-tool: <actual authoring tool>
```

The placeholders are not valid provenance. Use evidence from the authoring
session. Keep unknown historical values unknown; do not infer a model from
the current template or replace missing attribution with invented metadata.

A human-only commit carries the human's own `Signed-off-by` certification.
No agent writes a `Signed-off-by` line. Every project commit also requires a
cryptographic signature. The intended DCO app exemption for signed
organisation-member commits does not exempt those commits from the repository's
provenance checks.

## Review and handoff

The builder cannot approve its own work. A frontier model from a different
company than the builder's reviews the actual revision in a fresh context.
Copilot reviews the hosted revision; a human makes the merge decision after
the required checks and findings are resolved.
The conformance proofs in [Contributing](CONTRIBUTING.md) remain separate.

[Model roles](docs/agents/model-roles.md) defines the written handoff. Agents
reconstruct development context from repository files, the ticket, and current
evidence. Private conversation memory must not supply missing requirements.
Product records, knowledge, and execution state remain durable.

## Outside submissions

Outside contributions are closed. When they open, contributors must disclose
AI assistance, inspect every submitted line, reproduce reported bugs, and
respond to review. Unattributed generated issues, unsolicited automated
reviews, speculative security reports without reproduction, and bulk
unverified submissions are not accepted.

No paid human review, external security assessment, or legal opinion is
claimed complete by this foundation. Copyright and licensing questions remain
for counsel. See [Licensing](LICENSING.md).
