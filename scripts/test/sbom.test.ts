import { describe, expect, it } from "vitest";
import { buildSbom, hashFromIntegrity, packageNameFromKey, sbomDigest } from "../sbom.js";

const lock = {
  packages: {
    "": { version: "0.1.0" },
    "node_modules/zod": {
      version: "4.6.7",
      integrity: "sha512-AAAA",
      dev: false,
    },
    "node_modules/@do-sift/storage": { version: "0.1.0", dev: true },
    "node_modules/a/node_modules/b": { version: "1.0.0" },
  },
};

describe("sbom", () => {
  it("strips nested node_modules prefixes and tolerates missing fields", () => {
    expect(packageNameFromKey("node_modules/@scope/pkg")).toBe("@scope/pkg");
    expect(packageNameFromKey("node_modules/a/node_modules/b")).toBe("b");
  });

  it("builds a deterministic, sorted component list", () => {
    const a = buildSbom({ name: "do-sift", version: "0.1.0" }, lock);
    const b = buildSbom({ name: "do-sift", version: "0.1.0" }, lock);
    expect(a.components.map((c) => c.name)).toEqual(["@do-sift/storage", "b", "zod"]);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(sbomDigest(a)).toBe(sbomDigest(b));
    expect(a.metadata.timestamp).toBeUndefined();
    expect(a.components.find((c) => c.name === "zod")?.scope).toBe("required");
    expect(a.components.find((c) => c.name === "@do-sift/storage")?.scope).toBe("optional");
  });

  it("omits hashes it cannot decode instead of inventing them", () => {
    const decoded = hashFromIntegrity("sha512-AAAA");
    expect(decoded?.alg).toBe("SHA-512");
    expect(decoded?.content).toBe(Buffer.from("AAAA", "base64").toString("hex"));
    expect(hashFromIntegrity("sha999-AAAA")).toBeUndefined();
    expect(hashFromIntegrity("nonsense")).toBeUndefined();
  });

  it("records an explicit timestamp only when asked", () => {
    const sbom = buildSbom({}, lock, { created: "2026-11-17T00:00:00.000Z" });
    expect(sbom.metadata.timestamp).toBe("2026-11-17T00:00:00.000Z");
  });
});
