# 0008 — TypeScript/Node only; no authored Python

Status: accepted (first recorded 2026-09-06 in `plans/adr/0001-typescript-node.md`)

## Context

The product is a server, a worker, a CLI, and a plugin ecosystem. Supporting
two runtimes doubles the toolchain, the CI matrix, the packaging story, and the
set of native-dependency failures an operator can hit. Many ML-adjacent
libraries are Python-first; pulling one in would import that cost.

## Decision

All first-party code and tooling is **TypeScript on Node.js (>= 22)**. We do
not author `.py` files, Python manifests, or invoke a Python interpreter from
maintained code. The `noPython` policy check (INV-001) enforces it, including
invocations in scripts.

## Consequences

- One toolchain: `npm ci`, `npm run check`. No virtualenv, no interpreter
  version matrix.
- Native dependencies must ship prebuilt binaries for the target platforms. A
  package that needs a Python-driven native build is rejected, which is why
  embeddings use `@huggingface/transformers` on onnxruntime-node rather than a
  Python pipeline.
- Third-party GitHub Actions may use Python internally; that is outside our
  boundary and is not claimed otherwise.
- Python interoperability, if it is ever wanted, goes through a protocol
  boundary — not by embedding an interpreter. See the Python interop spike
  decision in `plans/`.
