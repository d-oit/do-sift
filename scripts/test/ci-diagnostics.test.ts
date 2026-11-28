/**
 * CI failure classification tests (issue #183). Pure function: every rule is
 * provable from a synthetic step name + sanitized error excerpt.
 */
import { describe, expect, it } from "vitest";
import { classifyFailure } from "../ci-diagnostics.js";

describe("classifyFailure", () => {
  it("is always advisory", () => {
    const out = classifyFailure({ job: "check", step: "npm ci", exitCode: 1, stderr: "boom" });
    expect(out.advisory).toBe(true);
  });

  it("classifies the native install failure class (onnxruntime CUDA 404)", () => {
    const out = classifyFailure({
      job: "check",
      step: "npm ci",
      exitCode: 1,
      stderr: "prebuild-install http 404 onnxruntime-node cuda download failed",
    });
    expect(out.category).toBe("native-install");
    expect(out.evidence).toBeTruthy();
  });

  it("classifies npm resolution failures", () => {
    const out = classifyFailure({
      job: "check",
      step: "npm ci",
      exitCode: 1,
      stderr: "npm error code ERESOLVE npm error peer dep conflict",
    });
    expect(out.category).toBe("dependency-resolution");
  });

  it("classifies assertion failures as test regressions, not transient errors", () => {
    const out = classifyFailure({
      job: "check",
      step: "vitest run",
      exitCode: 1,
      stderr: "AssertionError: expected 1 to be 2\nTests failed",
    });
    expect(out.category).toBe("test-regression");
    expect(out.suggestion).toMatch(/never retry/i);
  });

  it("routes generic network errors to runner infrastructure", () => {
    const out = classifyFailure({
      job: "check",
      step: "npm ci",
      exitCode: 1,
      stderr: "network error ECONNRESET while fetching the registry",
    });
    expect(out.category).toBe("runner-infrastructure");
  });

  it("routes provider-step network errors to the external provider", () => {
    const out = classifyFailure({
      job: "nightly-live",
      step: "live eval",
      exitCode: 1,
      stderr: "429 rate limit exceeded",
      provider: "example-search",
    });
    expect(out.category).toBe("external-provider");
    expect(out.suggestion).toMatch(/do not convert/i);
  });

  it("returns unknown (with a next step) for unmatched failures", () => {
    const out = classifyFailure({
      job: "container",
      step: "docker build",
      exitCode: 125,
      stderr: "weird",
    });
    expect(out.category).toBe("unknown");
    expect(out.suggestion).toMatch(/raw step log/i);
  });
});
