*How and why specs are written, what makes something a spec, and the rules for specs.*

# Spec policy

## Specs are authority

Specs are the source of truth. Everything else — code, tests, docs — defers
to and follows from them. `docs/` is reference and orientation material; it
informs but does not bind.

Every spec states what it is authoritative for, and ownership is exclusive:
each message shape, term, and behavior is defined in exactly one spec, and
other specs link to the owner rather than restating. A more specific spec may
state an explicit deviation from a general policy, and within its area that
statement wins; silence inherits the policy.

## Slop-free zone

Specs are a slop-free zone — one of the most important reasons they exist.
AI-written content tends towards slop: plausible-looking statements,
half-considered decisions, eager overcomplication. Once slop becomes
authority, later work compounds on it. So: AI may help draft a spec, but a
human has read each line, understood it, and stands behind it as correct and
intentional.

## Kinds of spec

- **The root spec** (`spec/index.md`) — what Pino is: purpose, principles,
  components.
- **Component specs** — one per component: its behavior, responsibilities,
  operations, and which schemas it serves and consumes.
- **Schema specs** — one per wire: the messages that cross a component
  boundary. Pino's contracts are message schemas, so these are the
  highest-authority contract documents in the tree.

## Schemas are the contracts

A schema spec's authoritative form is the message shapes themselves — field
names, types, example messages, precisely captured. Ambiguous prose contracts
are where bugs and churn come from; precise shapes remove ambiguity.

Schemas are language-neutral by principle (see [[index.md]]): no
implementation's type definitions are the contract. Each implementation
restates the shapes in its own source; that duplication is expected, and
drift is caught in review. Pin the contract surface — what crosses the
boundary — not component internals; state behavior as rules in prose, with
rationale for any demand whose weight a cold reader couldn't judge ("because
…" turns an opaque constraint into one a future editor can reason about).

## Authority cascade, and back pressure

```
spec prose  →  test assertions stated in specs  →  real tests  →  real code
```

Review pushes authority back *up* the chain: when implementation surfaces a
problem or decision, the learning lands in the spec — that back pressure is
welcome and expected. A best-effort spec that starts an experimental
implementation is fine; specs silently drifting from reality is not. When
downstream is unclear how to implement correctly, upstream needs more
clarity.

## Cold-reader policy

A spec describes the system as it is now, as if the current design is the
only one that ever existed. It defines its terms up front (terms are
defined authoritatively in [[terms.md]], italicized on definition and
maintained by review; other specs use them and elaborate behavior), assumes
a competent engineer with no project history, and never leans on insider
history —
except when history is genuinely the clearest explanation of a present
wrinkle. Negative boundaries are good spec language ("does not validate
inputs") when a reader might otherwise assume the opposite.

Every spec opens with a **plain-english intro**: a couple of sentences
telling a cold reader — even a lay one — what the spec governs and why it
exists, before any invented terms or contract language.

## Layout

```
spec/
  index.md            the root spec
  spec-policy.md      this document
  *.md                component and schema specs — flat until scale
                      justifies folders
```

Keep a spec coherent and under a few hundred lines; split along boundaries of
authority when it outgrows that.

## References

Specs are viewed and edited in Obsidian; links between specs use Obsidian
syntax (`[[runner.md]]`; link by path when a basename isn't unique). A *block
ref* (`^runner-single-writer`) anchors a statement so tests or other specs
can cite it exactly; anchor only what's worth citing, keep tokens unique
across the tree, and never reuse one.

## Review discipline, not procedural enforcement

Spec tree integrity comes from clear authority and from review — by humans
and by agents — not from CI gates or linters. These rules are policy that
intelligent reviewers apply, not machinery.
