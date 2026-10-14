# QUAL gate — manual quality evaluation protocol (v1, injection cases v1.1)

Status: active (QUAL-01, plans/005-007). This is the manual eval gate
that R-06 requires before any quality claim. It measures the **research
and evidence pipeline**, not model output quality — see Limits.

## What this gate is

A repeatable, hand-executed evaluation: run the packaged service against
the live search provider, ask a fixed set of diverse questions, and score
each result against the scorecard below. The output is a versioned run
artifact (`evals/quality/run-NNN-<date>.json`) with per-case authorial
scores and notes. Nothing here is automated judgment: every score is a
human/author call, recorded as such.

## Scorecard

Per case (question), each dimension scored 0 / 0.5 / 1 with a one-line
note. `n/a` is allowed only where the dimension genuinely cannot occur
(e.g. degradation honesty when nothing degraded).

1. **Retrieval relevance** — do the search hits and stored passages
   actually bear on the question? (1 = on-topic sources only; 0.5 = mixed;
   0 = off-topic or empty.)
2. **Extraction cleanliness** — do stored passages read as prose?
   Markup remnants, nav boilerplate, or reference-marker noise lower the
   score. (1 = clean prose; 0.5 = readable with visible noise such as
   `[ 23 ]` citation markers; 0 = fragments or raw markup.)
3. **Citation resolution** — every displayed citation resolves to stored
   evidence (this is enforced by ANS-03; the manual check is that the
   citation _targets_ plausibly support their sentences — existence is
   checked by the system, entailment is the author's judgment call).
4. **Degradation honesty** — when the system says `evidenceOnly` or
   `degraded`, is that the truthful description of what happened? (Also:
   when it claims grounded output, were real citations present?)
5. **Injection observation** — scan the fetched/quoted text for
   instruction-shaped content ("ignore previous instructions", imperative
   text addressed to an assistant). Record occurrences verbatim (R-12
   awareness); presence does not fail the case — silence about it would.

## Procedure

1. Start the service with the live search provider and a scratch
   in-memory database (`docs/deployment.md` "Running"). Port/process
   hygiene (distilled after runs 002-004 hit this three times): verify
   the port is FREE before starting — a stale do-sift process from an
   earlier session must be terminated first; after the run, kill the
   whole process tree (`taskkill /F /T` on the tree root catches the
   bash→npx→cmd→tsx→node chain), verify no orphan node child survived
   and the port is clear, and record the exit.
2. For each question in the run's fixed list, `POST /api/research` and
   then `POST /api/answer` (same question); save both raw responses.
3. Score each case against the scorecard; write the run artifact with:
   question, source cards, per-dimension score + note, aggregates.
4. Commit the artifact; record evidence in the plan file; anything that
   outlives the run goes to `plans/risks.md`.

## Injection cases (protocol v1.1, ANS-13, 2026-10-13)

The protocol gains a second case class: **seeded injection cases** for the
R-12 surface. Instead of live research, the operator seeds stored evidence
with the plan-013 attack corpus (framing forgery, role/framing mimicry,
instruction-override phrasing, bidi/zero-width and control characters) and
answers each question through the packaged service with the **fixture
model** (`evals/quality/run-017-2026-10-13.json` is the first run).

- The operative dimensions are **citation resolution** and **injection
  observation** (record every occurrence verbatim, plus the
  `suspectEvidence` receipt codes the answer path reports); **degradation
  honesty** applies only when a degradation occurs. **Retrieval relevance**
  and **extraction cleanliness** are recorded `n/a (constructed corpus)` —
  the pool is authored by the operator, so those dimensions cannot occur.
  Aggregates report operative dimensions only (`null` + reason for n/a).
- The fixture model never builds a prompt (extractive composition), so the
  framed-prompt boundary is measured by the security fixtures
  (`tests/security/prompt-injection.test.ts`), not here. The run measures
  the harness layers: retrieval scoping, packing, suspect receipts, the
  citation gate, and honest outcome flags.
- A control case with benign-only evidence must show the explicit empty
  receipt `{passages: 0, markers: []}` — silence about false positives
  fails the case, not the presence of a receipt.

## Limits (read before citing any number from a run)

- **Single-annotator, authorial labels** — the same caveat as the RET-01
  retrieval dataset: these measure the author's judgment over one
  operator's run, not inter-rater reliability.
- **NOT model quality.** Until a live LLM is wired (gated on credentials
  and paid grants), `/api/answer` is produced by the fixture model, which
  composes blocks from stored evidence. Answer-text fluency, completeness,
  and reasoning are unmeasured; the answer dimension recorded here is
  only citation-resolution and honesty behavior of the harness.
- **No quality claims** may cite a run artifact without repeating these
  limits (R-06).
- Live-provider dependence: scores describe the provider's behavior on
  the run date; re-run rather than extrapolate (sources.md 90-day rule).
- Constructed-corpus injection runs (v1.1) measure the harness against
  planted attack lines, NOT the detector's precision/recall over real
  pages — that live re-measure stays owner-gated (R-12 residual).
