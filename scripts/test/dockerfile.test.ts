import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const dockerfile = readFileSync(join(process.cwd(), "Dockerfile"), "utf8");

describe("container profile", () => {
  it("splits dependency/build and runtime stages", () => {
    expect(dockerfile).toMatch(/FROM node:24-slim AS deps/u);
    expect(dockerfile).toMatch(/FROM deps AS build/u);
    expect(dockerfile).toMatch(/FROM node:24-slim AS runtime/u);
  });

  it("keeps the runtime minimal and non-root", () => {
    const runtime = dockerfile.slice(dockerfile.indexOf("FROM node:24-slim AS runtime"));
    expect(runtime).toContain("npm ci --omit=dev");
    expect(runtime).toContain("USER node");
    expect(runtime).not.toContain("npm ci --include=dev");
  });

  it("runs the offline evals during the build stage only", () => {
    const build = dockerfile.slice(
      dockerfile.indexOf("FROM deps AS build"),
      dockerfile.indexOf("FROM node:24-slim AS runtime"),
    );
    expect(build).toContain("npm run eval:offline");
    const runtime = dockerfile.slice(dockerfile.indexOf("FROM node:24-slim AS runtime"));
    expect(runtime).not.toContain("npm run eval:offline");
  });

  it("keeps the healthcheck pointed at /healthz", () => {
    expect(dockerfile).toContain("/healthz");
    expect(dockerfile).toContain("HEALTHCHECK");
  });
});
