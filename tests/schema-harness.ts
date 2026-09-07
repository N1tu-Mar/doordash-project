/**
 * Applies the real migrations to a real Postgres, in-process.
 *
 * PGlite is Postgres compiled to WebAssembly — the actual engine, not a
 * simulation of it, so plpgsql function bodies, RLS policies, triggers, views
 * and CHECK constraints all behave as they will in production. It needs no
 * Docker and no local server, which is why schema verification can now run in
 * `pnpm test` on any machine instead of only in CI.
 *
 * CI still applies the same files to a stock Postgres 16 container, and that
 * run stays authoritative: PGlite tracks a different Postgres major and runs on
 * wasm32. This harness catches the errors that are worth catching in under a
 * second; CI catches the rest.
 *
 * NOTHING HERE INSERTS A ROW. Not an order, not an item, not a user. PROMPT.md
 * §2 bans invented users as firmly as invented receipts, and "it is only a test
 * database" is precisely the exception the rule exists to refuse. Every
 * assertion is made by reading the catalog.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";

const ROOT = process.cwd();
const MIGRATIONS_DIR = join(ROOT, "supabase", "migrations");
const CI_DIR = join(ROOT, "supabase", "ci");

/**
 * Strips psql meta-commands (`\set`, `\i`, …).
 *
 * They are real and load-bearing when CI pipes these files through psql —
 * `\set ON_ERROR_STOP on` is what makes a failed statement fail the build — but
 * they are a psql client feature, not SQL, and the server never sees them.
 */
function stripPsqlMetaCommands(sql: string): string {
  return sql
    .split("\n")
    .filter((line) => !/^\s*\\/.test(line))
    .join("\n");
}

export function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
}

export interface AppliedSchema {
  db: PGlite;
  /** Migration filenames, in the order they were applied. */
  applied: string[];
}

/**
 * Boots Postgres, applies the auth shim and then every migration in order.
 *
 * Throws with the offending filename on the first failure, because "syntax
 * error at or near" with no file attached is the least useful error in this
 * project.
 */
export async function applyMigrations(): Promise<AppliedSchema> {
  const db = await PGlite.create({ extensions: { pgcrypto } });

  const shim = stripPsqlMetaCommands(readFileSync(join(CI_DIR, "00_auth_shim.sql"), "utf8"));
  await db.exec(shim);

  const applied: string[] = [];
  for (const file of migrationFiles()) {
    const sql = stripPsqlMetaCommands(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
    try {
      await db.exec(sql);
    } catch (err) {
      throw new Error(
        `migration ${file} failed to apply: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    applied.push(file);
  }

  return { db, applied };
}

/** Runs supabase/ci/01_assert_schema.sql. It raises on any violated invariant. */
export async function runSchemaAssertions(db: PGlite): Promise<void> {
  const sql = stripPsqlMetaCommands(readFileSync(join(CI_DIR, "01_assert_schema.sql"), "utf8"));
  await db.exec(sql);
}

/** One-column catalog query, as a string array. */
export async function column(db: PGlite, sql: string): Promise<string[]> {
  const result = await db.query<Record<string, unknown>>(sql);
  return result.rows.map((row) => String(Object.values(row)[0]));
}
