# ADR 0003 — Evidence contract with pre-merge provenance

Status: accepted 2026-09-06

## Context

Perplexity-style answers are only as trustworthy as their citations. We
inspected upstream resolvers whose final outputs flatten multiple sources
into one merged markdown blob, losing per-source provenance — unusable for
validated citations.

## Decision

The system stores structured evidence **before** any merge or synthesis:
`SearchHit` (url, title, snippet, provider, rank, optional dated publication),
`EvidencePassage` (stable id, owner, canonical/original url, document
version/hash, retrieved-at, optional published-at with origin, heading,
excerpt), and `Answer` blocks whose claims reference evidence IDs. Citation
IDs are validated against stored evidence before display; invalid references
degrade the response to evidence-only (no LLM repair loop).

## Consequences

- Providers are wrapped so per-source data survives; provider SDK objects
  never leak into stored contracts (zod-validated boundaries).
- Citation existence ≠ factual entailment; quality claims require manual
  evaluation (QUAL gate). Validation is a floor, not a certificate.
- Retrieval time is never displayed as publication time.
