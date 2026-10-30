/**
 * Automated drift and compatibility checks for do-harness configuration,
 * TypeScript sensor registry (SENSOR_DEFS/SIGNAL_SETS), plans/methods.json,
 * and living documentation version pins.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SENSOR_DEFS, SIGNAL_SETS } from "../sensors.js";

const ROOT = process.cwd();

type HarnessTomlSensor = {
  name: string;
  argv: string[];
};

type HarnessTomlConfig = {
  language: string;
  signalSets: Record<string, string[]>;
  sensors: HarnessTomlSensor[];
};

function parseHarnessToml(content: string): HarnessTomlConfig {
  const lines = content.split(/\r?\n/);
  let language = "";
  const signalSets: Record<string, string[]> = {};
  const sensors: HarnessTomlSensor[] = [];

  let currentSection = "";
  let currentSensorName: string | undefined;
  let currentSensorArgv: string[] | undefined;

  const pushSensorIfValid = (): void => {
    if (currentSensorName !== undefined && currentSensorArgv !== undefined) {
      sensors.push({ name: currentSensorName, argv: currentSensorArgv });
    }
    currentSensorName = undefined;
    currentSensorArgv = undefined;
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    if (line.startsWith("[[sensors]]")) {
      pushSensorIfValid();
      currentSection = "sensors";
      continue;
    }

    if (line.startsWith("[")) {
      pushSensorIfValid();
      const closeIdx = line.indexOf("]");
      if (closeIdx > 1) {
        currentSection = line.slice(1, closeIdx).trim();
      }
      continue;
    }

    if (currentSection === "" && line.startsWith("language")) {
      const match = line.match(/^language\s*=\s*"([^"]+)"/);
      if (match && match[1] !== undefined) language = match[1];
    } else if (currentSection === "signal-sets") {
      const match = line.match(/^([a-zA-Z0-9_-]+)\s*=\s*\[(.*)\]/);
      if (match && match[1] !== undefined && match[2] !== undefined) {
        const setName = match[1];
        const rawItems = match[2];
        const items = rawItems
          .split(",")
          .map((s) => s.trim().replace(/^"|"$/g, ""))
          .filter(Boolean);
        signalSets[setName] = items;
      }
    } else if (currentSection === "sensors") {
      if (line.startsWith("name")) {
        const match = line.match(/^name\s*=\s*"([^"]+)"/);
        if (match && match[1] !== undefined) currentSensorName = match[1];
      } else if (line.startsWith("argv")) {
        const match = line.match(/^argv\s*=\s*\[(.*)\]/);
        if (match && match[1] !== undefined) {
          const rawItems = match[1];
          currentSensorArgv = rawItems
            .split(",")
            .map((s) => s.trim().replace(/^"|"$/g, ""))
            .filter(Boolean);
        }
      }
    }
  }

  pushSensorIfValid();

  return { language, signalSets, sensors };
}

describe("do-harness.toml configuration drift & compatibility", () => {
  const tomlPath = join(ROOT, "do-harness.toml");

  it("exists and specifies language = node", () => {
    expect(existsSync(tomlPath)).toBe(true);
    const content = readFileSync(tomlPath, "utf8");
    const config = parseHarnessToml(content);
    expect(config.language).toBe("node");
  });

  it("declares sensors matching SENSOR_DEFS 1:1 in name and order", () => {
    const content = readFileSync(tomlPath, "utf8");
    const config = parseHarnessToml(content);
    const tomlSensorNames = config.sensors.map((s) => s.name);
    const tsSensorNames = SENSOR_DEFS.map((s) => s.name);

    expect(tomlSensorNames).toEqual(tsSensorNames);
  });

  it("declares signal sets matching SIGNAL_SETS in composition", () => {
    const content = readFileSync(tomlPath, "utf8");
    const config = parseHarnessToml(content);

    expect(Object.keys(config.signalSets).sort()).toEqual(Object.keys(SIGNAL_SETS).sort());

    for (const [setName, sensors] of Object.entries(config.signalSets)) {
      const tsSensors = SIGNAL_SETS[setName as keyof typeof SIGNAL_SETS];
      expect(sensors).toEqual([...tsSensors]);
    }
  });
});

describe("plans/methods.json sensor references", () => {
  it("only references valid configured sensor names", () => {
    const methodsPath = join(ROOT, "plans", "methods.json");
    expect(existsSync(methodsPath)).toBe(true);
    const methodsJson = JSON.parse(readFileSync(methodsPath, "utf8")) as {
      methods: Array<{
        subtasks: Array<{ sensor: string | null }>;
      }>;
    };

    const validSensorNames = new Set(SENSOR_DEFS.map((s) => s.name));

    for (const method of methodsJson.methods) {
      for (const subtask of method.subtasks) {
        if (subtask.sensor !== null) {
          expect(validSensorNames.has(subtask.sensor)).toBe(true);
        }
      }
    }
  });
});

describe("living documentation version pin consistency", () => {
  const livingDocs = [
    join(ROOT, "AGENTS.md"),
    join(ROOT, ".agents", "skills", "dev-signals", "SKILL.md"),
    join(ROOT, "llms.txt"),
  ];

  it("consistently references v0.4.0 for do-harness upstream release", () => {
    for (const docPath of livingDocs) {
      expect(existsSync(docPath)).toBe(true);
      const text = readFileSync(docPath, "utf8");
      expect(text).toContain("v0.4.0");
      expect(text).not.toContain("v0.3.5");
    }
  });
});
