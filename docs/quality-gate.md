# QUAL gate — manual quality evaluation protocol (v1)

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
   in-memory database (`docs/deployment.md` "Running").
2. For each question in the run's fixed list, `POST /api/research` and
   then `POST /api/answer` (same question); save both raw responses.
3. Score each case against the scorecard; write the run artifact with:
   question, source cards, per-dimension score + note, aggregates.
4. Commit the artifact; record evidence in the plan file; anything that
   outlives the run goes to `plans/risks.md`.

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
