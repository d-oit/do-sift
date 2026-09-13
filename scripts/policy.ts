/**
 * do-sift deterministic policy checks (plans/invariants.json).
 * A deliberate violation must fail this script (FND-09); a silently green
 * check is treated as a failure (INV-006).
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const ROOT = process.cwd();
const findings: string[] = [];

function addFinding(check: string, message: string): void {
  findings.push(`[${check}] ${message}`);
}

/** Collect maintained source files (code only — prose may discuss anything). */
function collectFiles(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (entry === "node_modules" || entry === "dist" || entry === ".git") continue;
      collectFiles(p, out);
    } else {
      out.push(p);
    }
  }
  return out;
}

const CODE_EXT = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs", ".json", ".yml", ".yaml"]);
const SCAN_DIRS = ["packages", "apps", "scripts", ".github"].map((d) => join(ROOT, d));
const codeFiles = SCAN_DIRS.flatMap((d) => collectFiles(d)).filter(
  (f) => CODE_EXT.has(f.slice(f.lastIndexOf(".") + 1)) && !f.endsWith("package-lock.json"),
);

// ---- check: noPython (INV-001) -------------------------------------------
function checkNoPython(): void {
  const pythonFileNames = new Set([
    "pyproject.toml",
    "requirements.txt",
    "setup.py",
    "setup.cfg",
    "pipfile",
    "poetry.lock",
  ]);
  const allMaintained = [...SCAN_DIRS, join(ROOT, ".agents"), ROOT].flatMap((d) => collectFiles(d));
  for (const f of allMaintained) {
    const base = f.slice(f.lastIndexOf(sep) + 1).toLowerCase();
    if (base.endsWith(".py")) addFinding("noPython", `authored Python file: ${rel(f)}`);
    if (pythonFileNames.has(base)) addFinding("noPython", `Python manifest: ${rel(f)}`);
  }
  const invocation = /(^|[\s"'`(=:,{])(python3?|pip3?)\b/u;
  for (const f of codeFiles) {
    const lines = readFileSync(f, "utf8").split(/\r?\n/);
    lines.forEach((line, i) => {
      if (
        invocation.test(line) &&
        !line.trimStart().startsWith("//") &&
        !line.includes("python-free") &&
        !line.includes("no Python")
      ) {
        addFinding(
          "noPython",
          `${rel(f)}:${i + 1} possible Python invocation: ${line.trim().slice(0, 120)}`,
        );
      }
    });
  }
}

// ---- check: noStealthPatterns (INV-004) -----------------------------------
function checkNoStealthPatterns(): void {
  const patterns: Array<[RegExp, string]> = [
    [/stealth/iu, "stealth plugin/reference"],
    [/webdriver[._-]?(spoof|patch|hide)/iu, "webdriver spoofing"],
    [/fingerprint[._-]?(spoof|inject|patch)/iu, "fingerprint tampering"],
    [/captcha/iu, "captcha handling (solving/bypass is out of scope)"],
    [/capsolver|2captcha|anticaptcha/iu, "captcha solver service"],
    [/navigator\.webdriver\s*=/u, "navigator.webdriver override"],
  ];
  const harnessFiles = codeFiles.filter(
    (f) => f.includes(`${sep}packages${sep}`) || f.includes(`${sep}apps${sep}`),
  );
  for (const f of harnessFiles) {
    const lines = readFileSync(f, "utf8").split(/\r?\n/);
    lines.forEach((line, i) => {
      if (line.trimStart().startsWith("//")) return;
      for (const [re, label] of patterns) {
        if (re.test(line)) addFinding("noStealthPatterns", `${rel(f)}:${i + 1} ${label}`);
      }
    });
  }
}

// ---- check: noSecretLikeFiles (INV-005) ------------------------------------
function checkNoSecrets(): void {
  const forbiddenNames = [".env", ".pem", ".pfx", ".p12", "id_rsa", "id_ed25519"];
  const allMaintained = [...SCAN_DIRS, join(ROOT, ".agents"), ROOT].flatMap((d) => collectFiles(d));
  for (const f of allMaintained) {
    const base = f.slice(f.lastIndexOf(sep) + 1).toLowerCase();
    if (base === ".env.example") continue;
    if (forbiddenNames.some((n) => base === n || base.endsWith(n))) {
      addFinding("noSecretLikeFiles", `secret-like file present: ${rel(f)}`);
    }
  }
  const keyPattern = /-----BEGIN (?:RSA |OPENSSH |EC |DSA |PGP )?PRIVATE KEY-----/u;
  const tokenPattern =
    /\b(?:ghp_[A-Za-z0-9]{30,}|gho_[A-Za-z0-9]{30,}|AKIA[0-9A-Z]{16}|sk-[A-Za-z0-9]{40,})\b/u;
  for (const f of codeFiles) {
    const text = readFileSync(f, "utf8");
    if (keyPattern.test(text)) addFinding("noSecretLikeFiles", `private key material in ${rel(f)}`);
    if (tokenPattern.test(text)) addFinding("noSecretLikeFiles", `token-like string in ${rel(f)}`);
  }
}

// ---- check: defaultDenyList (INV-007) --------------------------------------
function checkDefaultDenyList(): void {
  const p = join(ROOT, "packages", "contracts", "src", "sitepolicy.ts");
  if (!existsSync(p)) {
    addFinding("defaultDenyList", "packages/contracts/src/sitepolicy.ts is missing");
    return;
  }
  const text = readFileSync(p, "utf8");
  if (!text.includes("linkedin.com")) {
    addFinding("defaultDenyList", "default deny list no longer includes linkedin.com (ADR 0005)");
  }
}

// ---- check: pluginImports ---------------------------------------------------
function checkPluginImports(): void {
  const banned = [
    /from\s+["']node:(fs|net|child_process|http|https)["']/u,
    /require\(["']node:(fs|net|child_process|http|https)["']\)/u,
  ];
  const pluginDirs = [join(ROOT, "packages", "plugins"), join(ROOT, "apps")];
  const files = pluginDirs.flatMap((d) => collectFiles(d)).filter((f) => f.endsWith(".ts"));
  for (const f of files) {
    const lines = readFileSync(f, "utf8").split(/\r?\n/);
    lines.forEach((line, i) => {
      for (const re of banned) {
        if (re.test(line))
          addFinding(
            "pluginImports",
            `${rel(f)}:${i + 1} plugin must use kernel services, not raw node modules`,
          );
      }
    });
  }
}

// ---- check: invariants have enforcing checks --------------------------------
interface Invariant {
  id: string;
  enforcedBy: string;
}
function checkInvariants(): void {
  const invPath = join(ROOT, "plans", "invariants.json");
  if (!existsSync(invPath)) {
    addFinding("invariants", "plans/invariants.json missing");
    return;
  }
  const parsed = JSON.parse(readFileSync(invPath, "utf8")) as { invariants?: Invariant[] };
  const list = parsed.invariants ?? [];
  if (list.length === 0) addFinding("invariants", "no invariants registered");
  const implementedChecks = new Set([
    "noPython",
    "noStealthPatterns",
    "noSecretLikeFiles",
    "defaultDenyList",
    "pluginImports",
    "invariants",
    "scripts/skills-check.ts",
    "scripts/eval.ts",
    "scripts/check.ts",
    "packages/kernel/test/kernel.test.ts",
  ]);
  for (const inv of list) {
    if (!inv.enforcedBy || inv.enforcedBy.trim().length === 0) {
      addFinding("invariants", `${inv.id}: empty enforcedBy`);
      continue;
    }
    const refs = inv.enforcedBy.match(/[\w./-]+\.(?:ts|json)/gu) ?? [];
    const checkNames = [...inv.enforcedBy.matchAll(/\(check (\w+)\)/gu)].map((m) => m[1] ?? "");
    const okPaths = refs.every((r) => existsSync(join(ROOT, r)));
    const okChecks = checkNames.length === 0 || checkNames.every((c) => implementedChecks.has(c));
    if (!okPaths || !okChecks) {
      addFinding(
        "invariants",
        `${inv.id}: enforcedBy "${inv.enforcedBy}" references missing check(s)`,
      );
    }
  }
}

function rel(f: string): string {
  return relative(ROOT, f).split(sep).join("/");
}

function run(): number {
  checkNoPython();
  checkNoStealthPatterns();
  checkNoSecrets();
  checkDefaultDenyList();
  checkPluginImports();
  checkInvariants();

  if (findings.length === 0) {
    console.log("policy: PASS (6 checks, 0 findings)");
    return 0;
  }
  console.error(`policy: FAIL (${findings.length} finding(s))`);
  for (const f of findings) console.error(`  ${f}`);
  return 1;
}

process.exit(run());
