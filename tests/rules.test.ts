/**
 * The rules from PROMPT.md, enforced as tests.
 *
 * §2 (no fake data) and §4 (core/ is pure) are the two rules that cannot be
 * enforced by types and are the two that quietly rot. A comment saying "never
 * add faker" is a comment. This is a build failure.
 *
 * Everything here reads the repository as text. No network, no database.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = process.cwd();
const SOURCE_DIRS = ["core", "services", "ingest", "scripts", "tests"];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...walk(full));
    } else if (entry.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Every .ts file in the project, minus this one. The guard names the strings it
 * bans, so scanning itself would report a violation on every rule it enforces.
 */
const sourceFiles = SOURCE_DIRS.flatMap((dir) => {
  try {
    return walk(join(ROOT, dir));
  } catch {
    return [];
  }
}).filter((f) => !f.endsWith("rules.test.ts"));

/**
 * Source with comments removed.
 *
 * This codebase quotes its own rules in doc comments constantly — core/parse.ts
 * explains that it does NOT use parseFloat, in a comment containing the word
 * parseFloat. Scanning raw text would fail on the explanation rather than the
 * violation, so every check below runs against code only.
 */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

const read = (file: string): string => stripComments(readFileSync(file, "utf8"));
const rel = (file: string): string => relative(ROOT, file);

describe("PROMPT.md §2 — no fake data", () => {
  it("has no data-faking library in package.json", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const names = [
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.devDependencies ?? {}),
    ];
    for (const banned of ["faker", "@faker-js/faker", "chance", "casual", "falso", "@ngneat/falso"]) {
      expect(names, `${banned} is a data-faking library — PROMPT.md §2`).not.toContain(banned);
    }
  });

  it("never introduces a 'seed' ingestion source", () => {
    // The DB check constraint is the real enforcement; this catches the code
    // change that would come first, with a message that says why.
    for (const file of sourceFiles) {
      const text = read(file);
      expect(text, `${rel(file)} references a seed source — PROMPT.md §2`).not.toMatch(
        /source\s*[:=]\s*["']seed["']/,
      );
    }
  });

  it("keeps the seed source out of the migrations", () => {
    const dir = join(ROOT, "supabase", "migrations");
    const migrations = readdirSync(dir).filter((f) => f.endsWith(".sql"));
    expect(migrations.length, "no migrations found to check").toBeGreaterThan(0);

    for (const file of migrations) {
      const text = readFileSync(join(dir, file), "utf8");
      const sourceChecks = text.match(/source\s+in\s*\([^)]*\)/gi) ?? [];
      for (const check of sourceChecks) {
        expect(check, `${file} allows a seed source — PROMPT.md §2`).not.toMatch(/seed/i);
      }
    }
  });

  it("has no demo or fixture mode that fabricates a flow", () => {
    for (const file of sourceFiles) {
      const text = read(file).toLowerCase();
      for (const banned of ["demo_mode", "demomode", "usefixtures", "seeddatabase", "seeddb"]) {
        expect(text, `${rel(file)} contains ${banned} — PROMPT.md §2`).not.toContain(banned);
      }
    }
  });
});

describe("PROMPT.md §4 — core/ is pure", () => {
  const coreFiles = sourceFiles.filter((f) => rel(f).startsWith("core/"));

  it("actually found the core files it is meant to be checking", () => {
    // A guard that silently checks nothing is worse than no guard.
    expect(coreFiles.length).toBeGreaterThan(4);
  });

  it("imports nothing from services/, ingest/ or app/", () => {
    for (const file of coreFiles) {
      const text = read(file);
      for (const forbidden of ["../services/", "../ingest/", "../app/"]) {
        expect(text, `${rel(file)} imports ${forbidden} — core/ must stay pure`).not.toContain(
          forbidden,
        );
      }
    }
  });

  it("pulls in no network, database or model client", () => {
    for (const file of coreFiles) {
      const text = read(file);
      for (const forbidden of [
        "@anthropic-ai/sdk",
        "@supabase/supabase-js",
        "googleapis",
        "node:http",
        "node:https",
        "node-fetch",
      ]) {
        expect(text, `${rel(file)} depends on ${forbidden} — core/ must stay pure`).not.toContain(
          forbidden,
        );
      }
      // fetch() in core/ would make the money math untestable without mocking,
      // which is the entire reason for the layering rule.
      expect(text, `${rel(file)} calls fetch()`).not.toMatch(/\bfetch\s*\(/);
    }
  });

  it("reads no environment variables — configuration belongs in services/config.ts", () => {
    for (const file of coreFiles) {
      expect(read(file), `${rel(file)} reads process.env`).not.toContain("process.env");
    }
  });

  it("has no `any` in core/", () => {
    for (const file of coreFiles) {
      // `any` inside a word (Company, many) must not trip this.
      expect(read(file), `${rel(file)} uses any — PROMPT.md §4`).not.toMatch(
        /:\s*any\b|<any>|as\s+any\b/,
      );
    }
  });
});

describe("PROMPT.md §9 — money is integer cents", () => {
  it("has no parseFloat or Number() on a money string in core/", () => {
    for (const file of sourceFiles.filter((f) => rel(f).startsWith("core/"))) {
      expect(read(file), `${rel(file)} uses parseFloat`).not.toContain("parseFloat");
    }
  });

  it("has no toFixed() anywhere — it is float formatting wearing a money costume", () => {
    for (const file of sourceFiles) {
      expect(read(file), `${rel(file)} uses toFixed`).not.toContain("toFixed(");
    }
  });
});

describe("PROMPT.md §7 — research/ boundary", () => {
  it("writes nothing under research/ except REQUESTS.md", () => {
    for (const file of sourceFiles) {
      const text = read(file);
      const writes = text.match(/writeFileSync\(([^)]*)\)/g) ?? [];
      for (const call of writes) {
        if (!call.includes("research/")) continue;
        expect(call, `${rel(file)} writes into research/`).toContain("REQUESTS.md");
      }
    }
  });

  it("never commits the corpus", () => {
    const gitignore = readFileSync(join(ROOT, ".gitignore"), "utf8");
    expect(gitignore).toContain("research/corpus/");
  });
});
