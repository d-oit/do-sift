/**
 * Install-parity guard (issue #181): every Dockerfile stage that runs
 * `npm ci`/`npm install` must receive the canonical `.npmrc` first, so a
 * native dependency install cannot silently diverge from the documented
 * configuration (the onnxruntime-node CUDA-skip failure class, PR #179).
 */
import { describe, expect, it } from "vitest";
import { findUnconfiguredNpmStages } from "../deps-check.js";

describe("findUnconfiguredNpmStages", () => {
  it("passes a stage that copies .npmrc before npm ci", () => {
    const df = [
      "FROM node:24-slim AS deps",
      "COPY package.json package-lock.json .npmrc ./",
      "RUN npm ci --include=dev",
    ].join("\n");
    expect(findUnconfiguredNpmStages(df)).toEqual([]);
  });

  it("flags a stage that runs npm ci without a .npmrc copy", () => {
    const df = [
      "FROM node:24-slim AS runtime",
      "COPY package.json package-lock.json ./",
      "RUN npm ci --omit=dev",
    ].join("\n");
    const violations = findUnconfiguredNpmStages(df);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.stage).toBe("runtime");
    expect(violations[0]?.command).toContain("npm ci");
  });

  it("inherits .npmrc copies from a base stage via FROM", () => {
    const df = [
      "FROM node:24-slim AS deps",
      "COPY package.json package-lock.json .npmrc ./",
      "RUN npm ci",
      "FROM deps AS build",
      "RUN npm run build",
      "FROM node:24-slim AS runtime",
      "COPY --from=build /app/package.json ./",
      "RUN npm ci --omit=dev",
    ].join("\n");
    // deps and build inherited the copy; the runtime stage starts from a
    // bare base image and never receives .npmrc, so only it is flagged.
    const violations = findUnconfiguredNpmStages(df);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.stage).toBe("runtime");
  });

  it("ignores npm invocations that are not installs", () => {
    const df = ["FROM node:24-slim AS build", "RUN npm run build", "RUN npm run eval:offline"].join(
      "\n",
    );
    expect(findUnconfiguredNpmStages(df)).toEqual([]);
  });

  it("accepts multi-line RUN continuations", () => {
    const df = [
      "FROM node:24-slim AS deps",
      "COPY package.json package-lock.json ./",
      "RUN npm ci \\",
      "  --omit=dev",
    ].join("\n");
    const violations = findUnconfiguredNpmStages(df);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.line).toBe(3);
  });
});
