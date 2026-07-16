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

## Schemas are the contracts

Pino's contracts are message schemas, so schema specs are the
highest-authority contract documents in the tree. A schema spec's
authoritative form is the message shapes themselves — field names, types,
example messages, precisely captured. Ambiguous prose contracts are where
bugs and churn come from; precise shapes remove ambiguity.

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

## Test assertions

Each behavioral spec carries a **Test assertions** section: the behaviors it
owns, restated as assertions a test proves. The suite implements every
assertion (it may exceed them, never undershoot). An assertion is one bullet —
a bold **shape**, a short parenthetical naming what is crossed and how, the
statement, and a `^t-<domain>-<slug>` block ref a test can cite. ^test-assertions

Two behavioral shapes; every behavioral assertion declares one: ^test-shapes

- **Contract** — proves one side of a boundary in isolation, the other side
  scripted or mocked. Permutation breadth lives here. The assertion names the
  mock and the coverage it forfeits; that naming is the only thing that
  greenlights the mock.
- **Seam** — proves one real handoff crossed once on the production path (a
  real socket, a real spawned process, real pi-ai over real HTTP). A Seam runs
  no permutation breadth; it proves the wiring the Contracts assume.

Rules:

- Every real handoff needs at least one Seam. Contract tests never prove
  wiring, however exhaustive; a mock earns coverage only for the side it really
  runs.
- A mock is legitimate only where an assertion declares it. An undeclared mock
  is a defect, not an implementation detail.
- Tuning constants and version pins are not behavioral authority — assert the
  *rule* (an explicit finite bound; an exact pin), never the value. Where a
  value is frozen as a deliberate-bump tripwire, state it as a **Guard** — a
  static check that fails loudly on a silent change — not as behavior.

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
  index.md            the entry — an overview of Pino spanning both layers:
                      what it is, its principles, its components
  spec-policy.md      this document — how specs are written (procedural)
  terms.md            the glossary
  design/             what Pino is and how it behaves — the binding contracts,
                      reimplementable in any language: the wire (transport),
                      the storage layout, each schema (inference)
  implementation/     how this codebase realizes it: index.md maps the
                      packages; a lightweight spec per module (transport) and
                      component (gateway)
```

The split is **what Pino is and how it behaves** (`design/`, authority,
reimplementable in any language) versus **how this code does it**
(`implementation/`, packages, technology, the exported APIs). A design spec
owns behavior and message shapes; an implementation spec only names what its
module provides and mandates it exists — signatures are read from the code,
not pinned. `design/` and `implementation/` both hold a `transport.md` (the
wire vs. the package that speaks it), so cross-links use paths. `index.md` at
the root is the overview spanning both layers; `spec-policy.md` and `terms.md`
sit alongside it as procedure and glossary. Keep a spec coherent and under a
few hundred lines; split along boundaries of authority when it outgrows that.

## References

Specs are viewed and edited in Obsidian; links between specs use Obsidian
syntax — a unique basename may be bare (`[[storage.md]]`), a reused one is
linked by path (`[[design/transport.md]]`, not bare `[[transport.md]]`); the
root `index.md` is bare, the folder `implementation/index.md` is path-linked.
A *block ref* (`^storage-singleton`) anchors a statement so tests or other
specs can cite it exactly; anchor only what's worth citing, keep tokens
unique across the tree, and never reuse one.

## Review discipline, not procedural enforcement

Spec tree integrity comes from clear authority and from review — by humans
and by agents — not from CI gates or linters. These rules are policy that
intelligent reviewers apply, not machinery.
