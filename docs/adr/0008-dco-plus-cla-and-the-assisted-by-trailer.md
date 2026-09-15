# Separate provenance, human certification, and signatures

Accepted 6 September 2026; consolidated 8 September.

Commit attribution must identify how the change was authored. Agent-assisted
commits carry `Assisted-by: LLM`, the actual `Agent-model`, and the actual
`Agent-tool`. Human-only commits carry the human's own `Signed-off-by`.
An agent never writes a human certification. Missing model or tool evidence
must not be invented or supplied silently by a stale template.

Every project commit requires a cryptographic signature. The intended DCO app
configuration exempts verified signed organisation-member commits from its
sign-off requirement. That exemption does not remove repository provenance
requirements. Outside contributors certify the DCO themselves and complete
the CLA process when contributions open.

These are separate controls. A signature does not identify the authoring
model, a model trailer does not certify a human's right to submit, and an
outside contribution agreement does not replace either. Hosted DCO behaviour
and signature recognition require live proof. [AI policy](../../AI_POLICY.md)
and [Contributing](../../CONTRIBUTING.md) define the procedure.
