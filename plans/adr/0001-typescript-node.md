# ADR 0001 — TypeScript/Node only; no Python

Status: accepted 2026-09-06

## Context

The product is a web research engine with a browser UI, server API, background
worker, and plugin ecosystem. The owner requires zero authored Python and no
Python runtime requirement anywhere in the application or maintained tooling.

## Decision

All first-party code and tooling is TypeScript on Node.js (>= 22). We do not
author `.py` files, Python manifests, or invoke Python interpreters. CI
enforces this via `scripts/policy.ts` (INV-001).

## Consequences

- Third-party GitHub Actions may internally use Python; that is outside our
  boundary and explicitly not claimed otherwise.
- Some ecosystems' tools (e.g., some ONNX pipelines) are Python-first; we use
  JS/TS-native alternatives (`@huggingface/transformers` on onnxruntime-node)
  or defer the feature.
- Native dependencies must ship prebuilt binaries for our target platforms
  (win32 x64 dev; linux arm64 deploy candidate). A package whose install
  requires a Python-driven native build is rejected.
