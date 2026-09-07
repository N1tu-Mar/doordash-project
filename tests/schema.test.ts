/**
 * The migrations, actually executed.
 *
 * Until this file existed, supabase/migrations/ was unrun SQL: no Docker and no
 * Postgres on the development machine meant nothing had validated the syntax,
 * the trigger bodies, the RLS policy expressions or the views, and the first
 * execution would have been a deploy. That is a bad place to discover a typo in
 * a constraint that enforces PROMPT.md §2.
 *
 * Runs in-process via PGlite — see tests/schema-harness.ts, including why no
 * row is ever inserted.
 */
import { beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { applyMigrations, column, migrationFiles, runSchemaAssertions } from "./schema-harness.js";

let db: PGlite;
let applied: string[];

beforeAll(async () => {
  const schema = await applyMigrations();
  db = schema.db;
  applied = schema.applied;
}, 60_000);

describe("migrations apply", () => {
  it("applies every migration in order", () => {
    expect(applied).toEqual(migrationFiles());
    expect(applied.length).toBeGreaterThan(0);
  });

  it("has no duplicate migration numbers", async () => {
    // Two files claiming the same number is how one of them quietly never runs.
    // This branch already hit it once, against a concurrently-developed branch.
    const numbers = migrationFiles().map((f) => f.slice(0, 4));
    expect(new Set(numbers).size, `duplicate migration numbers in ${numbers.join(", ")}`).toBe(
      numbers.length,
    );
  });

  it("passes every assertion in supabase/ci/01_assert_schema.sql", async () => {
    // The same file CI runs against stock Postgres, and the same file the
    // deploy workflow runs against the real database after pushing.
    await expect(runSchemaAssertions(db)).resolves.toBeUndefined();
  });
});

describe("PROMPT.md §2 — the source constraint", () => {
  it("rejects a seed source at the database level", async () => {
    // The one write attempt in this suite, and it is one that MUST fail. A
    // statement that is rejected persists nothing, so no invented row exists
    // even for the duration of a transaction.
    await expect(
      db.exec(`insert into orders (
         user_id, source, ordered_at, merchant_name,
         subtotal_cents, fees_cents, tax_cents, tip_cents, total_cents,
         raw_artifact_path, parser_version, balance_delta_cents
       ) values (
         gen_random_uuid(), 'seed', now(), 'x',
         1, 0, 0, 0, 1, 'x', 'x', 0
       )`),
    ).rejects.toThrow();
  });

  it("accepts only the three real ingestion paths", async () => {
    const [definition] = await column(
      db,
      `select pg_get_constraintdef(con.oid)
         from pg_constraint con
         join pg_class rel on rel.oid = con.conrelid
        where rel.relname = 'orders' and con.contype = 'c'
          and pg_get_constraintdef(con.oid) ilike '%manual_entry%'`,
    );
    expect(definition).toBeDefined();
    expect(definition).toContain("gmail");
    expect(definition).toContain("photo");
    expect(definition).toContain("manual_entry");
    expect(definition).not.toContain("seed");
  });
});

describe("PROMPT.md §3.5 — the n >= 20 gate", () => {
  it("is compiled into the shortage index view, not applied by a caller", async () => {
    const [definition] = await column(
      db,
      `select pg_get_viewdef('merchant_shortage_index'::regclass)`,
    );
    expect(definition).toMatch(/>=\s*20/);
  });

  it("returns nothing on an empty database rather than a rate of zero", async () => {
    // "Not enough data" is true and is fine to say. A 0.0000 shortage rate for
    // every merchant would be a lie with a decimal point.
    const rows = await db.query("select * from merchant_shortage_index");
    expect(rows.rows).toHaveLength(0);
  });

  it("gates the recovery stats the same way", async () => {
    const [definition] = await column(db, `select pg_get_viewdef('claim_recovery_stats'::regclass)`);
    expect(definition).toMatch(/>=\s*20/);
    expect((await db.query("select * from claim_recovery_stats")).rows).toHaveLength(0);
  });
});

describe("immutability", () => {
  it("installs every trigger that protects a record of what happened", async () => {
    const triggers = await column(
      db,
      `select tgname from pg_trigger where not tgisinternal order by tgname`,
    );
    for (const expected of [
      "orders_immutable_columns",
      "discrepancies_immutable_detected",
      "confirmation_edits_append_only",
      "claims_immutable_amounts",
    ]) {
      expect(triggers, `${expected} is missing`).toContain(expected);
    }
  });
});

describe("RLS", () => {
  it("is enabled on every table holding user data", async () => {
    const unprotected = await column(
      db,
      `select c.relname
         from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity
        order by c.relname`,
    );
    expect(unprotected, `tables without RLS: ${unprotected.join(", ")}`).toEqual([]);
  });

  it("gives every RLS-enabled table an actual policy", async () => {
    // RLS with no policy denies everything, which fails closed but also fails
    // silently — a table nobody can read looks identical to a table with no rows.
    const policyless = await column(
      db,
      `select c.relname
         from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity
          and not exists (select 1 from pg_policies p
                          where p.schemaname = 'public' and p.tablename = c.relname)
        order by c.relname`,
    );
    expect(policyless, `RLS on with no policy: ${policyless.join(", ")}`).toEqual([]);
  });
});

describe("money columns", () => {
  it("are integers everywhere — no float has ever been near a dollar amount", async () => {
    const nonInteger = await column(
      db,
      `select table_name || '.' || column_name || ' is ' || data_type
         from information_schema.columns
        where table_schema = 'public' and column_name like '%_cents'
          and data_type not in ('integer', 'bigint')`,
    );
    expect(nonInteger).toEqual([]);
  });

  it("found money columns to check, so the guard is not passing vacuously", async () => {
    const centsColumns = await column(
      db,
      `select table_name || '.' || column_name from information_schema.columns
        where table_schema = 'public' and column_name like '%_cents'`,
    );
    expect(centsColumns.length).toBeGreaterThan(10);
  });
});

describe("PROMPT.md §3.2 — the rejection log stores no bodies", () => {
  it("has only metadata columns", async () => {
    const columns = await column(
      db,
      `select column_name from information_schema.columns
        where table_name = 'gmail_rejected_messages' order by column_name`,
    );
    for (const forbidden of ["body", "html", "body_html", "snippet", "raw_artifact_path"]) {
      expect(columns, `it grew a ${forbidden} column`).not.toContain(forbidden);
    }
    expect(columns).toContain("rejected_reason");
  });
});

/**
 * The assertions, tested.
 *
 * supabase/ci/01_assert_schema.sql passed on its first ever run, which is
 * either good news or a file that raises on nothing. These break one invariant
 * each in a throwaway database and require the assertions to catch it.
 *
 * Without them, a refactor that neutered the checks would look exactly like a
 * clean build — which is the failure mode that file was written to prevent.
 */
describe("the schema assertions fail when an invariant is actually broken", () => {
  it("catches RLS being turned off", async () => {
    const { db: broken } = await applyMigrations();
    await broken.exec("alter table orders disable row level security");
    await expect(runSchemaAssertions(broken)).rejects.toThrow(/row level security/i);
  }, 60_000);

  it("catches a seed source being added", async () => {
    const { db: broken } = await applyMigrations();
    await broken.exec(
      "alter table orders drop constraint orders_source_check; " +
        "alter table orders add constraint orders_source_check " +
        "check (source in ('gmail', 'photo', 'manual_entry', 'seed'));",
    );
    await expect(runSchemaAssertions(broken)).rejects.toThrow(/seed/i);
  }, 60_000);

  it("catches the source constraint being dropped entirely", async () => {
    // The vacuous-pass case. With the constraint gone there is nothing to find,
    // and the old name-based lookup would have reported success.
    const { db: broken } = await applyMigrations();
    await broken.exec("alter table orders drop constraint orders_source_check");
    await expect(runSchemaAssertions(broken)).rejects.toThrow(/no CHECK constraint/i);
  }, 60_000);

  it("catches the n >= 20 gate being removed from the shortage index", async () => {
    const { db: broken } = await applyMigrations();
    await broken.exec(
      "drop view merchant_shortage_index; " +
        "create view merchant_shortage_index with (security_invoker = on) as " +
        "select lower(o.merchant_name) as merchant_name_key, count(*) as observed_orders " +
        "from orders o group by 1;",
    );
    await expect(runSchemaAssertions(broken)).rejects.toThrow(/20|shortage/i);
  }, 60_000);

  it("catches an immutability trigger being dropped", async () => {
    const { db: broken } = await applyMigrations();
    await broken.exec("drop trigger discrepancies_immutable_detected on discrepancies");
    await expect(runSchemaAssertions(broken)).rejects.toThrow(/trigger/i);
  }, 60_000);

  it("catches a float creeping into a money column", async () => {
    const { db: broken } = await applyMigrations();
    await broken.exec("alter table orders add column refund_estimate_cents numeric(10,2)");
    await expect(runSchemaAssertions(broken)).rejects.toThrow(/not an integer type/i);
  }, 60_000);

  it("catches a body column appearing on the rejection log", async () => {
    const { db: broken } = await applyMigrations();
    await broken.exec("alter table gmail_rejected_messages add column body text");
    await expect(runSchemaAssertions(broken)).rejects.toThrow(/body column/i);
  }, 60_000);

  it("catches detected_items and confirmed_items being merged", async () => {
    const { db: broken } = await applyMigrations();
    await broken.exec("alter table discrepancies drop column detected_items");
    await expect(runSchemaAssertions(broken)).rejects.toThrow(/detected_items/i);
  }, 60_000);
});
