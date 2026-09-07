/**
 * The security half of the schema, checked against a real Postgres.
 *
 * tests/schema.test.ts covers the PROMPT.md data rules — the source constraint,
 * the n >= 20 gate, immutability, integer money. This file covers what migrations
 * 0003 and 0004 add: who can read whose rows, who can grant a role, and whether
 * the admin boards are gated in SQL rather than in TypeScript.
 *
 * It uses the same PGlite harness, so these are catalog queries against migrations
 * that actually executed — not regexes over the text of the files. A static check
 * cannot tell you that `revoke` resolved, that a policy expression compiled, or
 * that a SECURITY DEFINER function came out `stable`.
 *
 * NOTHING HERE INSERTS A ROW, for the same reason the sibling file does not.
 */
import { beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { applyMigrations, column } from "./schema-harness.js";

let db: PGlite;

beforeAll(async () => {
  db = (await applyMigrations()).db;
}, 60_000);

/** Privileges `authenticated` actually holds on a table, per the catalog. */
async function grantsFor(table: string): Promise<string[]> {
  return column(
    db,
    `select privilege_type from information_schema.role_table_grants
      where grantee = 'authenticated' and table_name = '${table}'
      order by privilege_type`,
  );
}

async function policiesOn(table: string): Promise<string[]> {
  return column(db, `select cmd from pg_policies where tablename = '${table}' order by cmd`);
}

describe("privilege escalation is not expressible", () => {
  it("gives authenticated only SELECT on user_roles", async () => {
    // The whole role model rests on this one row of the catalog. If INSERT ever
    // appears here, a user can grant themselves admin.
    expect(await grantsFor("user_roles")).toEqual(["SELECT"]);
  });

  it("defines no write policy on user_roles", async () => {
    expect(await policiesOn("user_roles")).toEqual(["SELECT", "SELECT"]);
  });

  it("keeps anon off user_roles entirely", async () => {
    const anon = await column(
      db,
      `select privilege_type from information_schema.role_table_grants
        where grantee = 'anon' and table_name = 'user_roles'`,
    );
    expect(anon).toEqual([]);
  });

  it("installs the trigger that rejects a write from a live session", async () => {
    const triggers = await column(
      db,
      `select tgname from pg_trigger t join pg_class c on c.oid = t.tgrelid
        where c.relname = 'user_roles' and not t.tgisinternal`,
    );
    expect(triggers).toContain("user_roles_no_self_service");
  });

  it("fires that trigger on insert, update AND delete", async () => {
    // 0d = INSERT|DELETE|UPDATE bitmask on pg_trigger.tgtype (2|4|8|16 = 28).
    const [tgtype] = await column(
      db,
      `select t.tgtype::int from pg_trigger t join pg_class c on c.oid = t.tgrelid
        where c.relname = 'user_roles' and t.tgname = 'user_roles_no_self_service'`,
    );
    const bits = Number(tgtype);
    expect(bits & 4, "INSERT").toBeTruthy();
    expect(bits & 8, "DELETE").toBeTruthy();
    expect(bits & 16, "UPDATE").toBeTruthy();
  });
});

describe("role predicates", () => {
  it("are SECURITY DEFINER and stable, so RLS policies can call them", async () => {
    const rows = await column(
      db,
      `select p.proname || ':' || p.prosecdef::text || ':' || p.provolatile::text
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname in ('is_admin','is_reviewer','has_role')
        order by p.proname`,
    );
    // secdef = t (definer), volatility = s (stable). Invoker rights here would
    // evaluate user_roles' own RLS from inside a policy that called it.
    expect(rows).toEqual(["has_role:true:s", "is_admin:true:s", "is_reviewer:true:s"]);
  });

  it("pin search_path on every one of them", async () => {
    const unpinned = await column(
      db,
      `select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and p.prosecdef
          and (p.proconfig is null
               or not exists (select 1 from unnest(p.proconfig) c where c like 'search_path=%'))`,
    );
    expect(unpinned).toEqual([]);
  });

  it("takes no user-supplied id — everything derives from auth.uid()", async () => {
    const args = await column(
      db,
      `select pg_get_function_arguments(p.oid)
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname in ('is_admin','is_reviewer')`,
    );
    expect(args.every((a) => a.trim() === "")).toBe(true);
  });
});

describe("admin boards are gated in SQL", () => {
  const BOARDS = [
    "admin_model_accuracy",
    "admin_merchant_shortage_index",
    "admin_ingest_health",
    "admin_corpus_coverage",
  ];

  it("exist as views", async () => {
    const views = await column(
      db,
      `select viewname from pg_views where schemaname = 'public' order by viewname`,
    );
    for (const board of BOARDS) expect(views, board).toContain(board);
  });

  it("carry a role predicate in the compiled view body", async () => {
    for (const board of BOARDS) {
      const [def] = await column(db, `select pg_get_viewdef('${board}'::regclass, true)`);
      // Compiled definition, not the file text: this proves the predicate
      // survived parsing and is part of the plan.
      expect(def, board).toMatch(/is_(admin|reviewer)\(\)/);
    }
  });

  it("are unreachable by anon", async () => {
    const leaked = await column(
      db,
      `select table_name from information_schema.role_table_grants
        where grantee = 'anon' and table_name like 'admin\\_%'`,
    );
    expect(leaked).toEqual([]);
  });

  it("keeps the shortage gate on distinct users, not just orders", async () => {
    const [def] = await column(
      db,
      `select pg_get_viewdef('admin_merchant_shortage_index'::regclass, true)`,
    );
    expect(def).toMatch(/count\(DISTINCT o\.id\) >= 20/i);
    // Twenty orders from one household is one household's experience.
    expect(def).toMatch(/count\(DISTINCT o\.user_id\) >= 5/i);
  });
});

describe("append-only tables are append-only for every role", () => {
  it("grants model_calls no UPDATE or DELETE", async () => {
    expect(await grantsFor("model_calls")).toEqual(["INSERT", "SELECT"]);
  });

  it("backs that with a trigger, which binds the service role too", async () => {
    // A policy binds `authenticated`. service_role has BYPASSRLS, so an audit
    // trail that is append-only by policy alone is not append-only.
    for (const [table, trigger] of [
      ["model_calls", "model_calls_append_only"],
      ["admin_audit_log", "admin_audit_append_only"],
    ]) {
      const triggers = await column(
        db,
        `select tgname from pg_trigger t join pg_class c on c.oid = t.tgrelid
          where c.relname = '${table}' and not t.tgisinternal`,
      );
      expect(triggers, table).toContain(trigger);
    }
  });

  it("hides admin_audit_log from ordinary users via its policy", async () => {
    const [qual] = await column(
      db,
      `select qual from pg_policies where tablename = 'admin_audit_log' and cmd = 'SELECT'`,
    );
    expect(qual).toMatch(/is_admin\(\)/);
  });
});

describe("storage artifacts", () => {
  it("creates both buckets private", async () => {
    const rows = await column(
      db,
      `select id || ':' || public from storage.buckets order by id`,
    );
    expect(rows).toEqual(["delivered-photos:false", "raw-receipts:false"]);
  });

  it("scopes object policies to the caller's own folder", async () => {
    const quals = await column(
      db,
      `select coalesce(qual, with_check) from pg_policies
        where tablename = 'objects' and policyname like 'shorted_artifacts%'`,
    );
    expect(quals.length).toBe(2);
    for (const q of quals) expect(q).toMatch(/foldername/);
  });

  it("defines no update or delete policy on artifacts", async () => {
    // Raw artifacts are the corpus. A parser bug must not be able to destroy
    // the evidence a claim was built on.
    const cmds = await column(
      db,
      `select cmd from pg_policies where tablename = 'objects'
         and policyname like 'shorted_artifacts%' order by cmd`,
    );
    expect(cmds.sort()).toEqual(["INSERT", "SELECT"]);
  });
});

describe("the atomic order writer", () => {
  it("exists with the taxable base 0006 adds", async () => {
    const [args] = await column(
      db,
      `select pg_get_function_arguments(p.oid) from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'insert_order_full'`,
    );
    expect(args).toContain("p_taxable_base_cents");
    expect(args).toContain("p_fee_lines");
  });

  it("takes no user_id argument — it reads auth.uid() itself", async () => {
    const [args] = await column(
      db,
      `select pg_get_function_arguments(p.oid) from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'insert_order_full'`,
    );
    expect(args).not.toContain("p_user_id");
    // Nor a fees total: it is derived from the lines, so they cannot disagree.
    expect(args).not.toContain("p_fees_cents");
  });

  it("leaves no callable copy of the fee-line-less predecessor", async () => {
    const survivors = await column(
      db,
      `select proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'insert_order_with_items'`,
    );
    expect(survivors).toEqual([]);
  });

  it("is executable by authenticated and not by anon", async () => {
    const [canAuth] = await column(
      db,
      `select has_function_privilege('authenticated', p.oid, 'EXECUTE')
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'insert_order_full'`,
    );
    const [canAnon] = await column(
      db,
      `select has_function_privilege('anon', p.oid, 'EXECUTE')
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'insert_order_full'`,
    );
    expect(canAuth).toBe("true");
    expect(canAnon).toBe("false");
  });
});

describe("RLS covers the tables 0003-0005 added", () => {
  it("forces row level security, so policies apply to the owner too", async () => {
    const unforced = await column(
      db,
      `select relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind = 'r'
          and c.relname in ('order_fee_lines','user_roles','admin_audit_log',
                            'orders','order_items','discrepancies','model_calls',
                            'gmail_ingest_consents','gmail_messages')
          and not (c.relrowsecurity and c.relforcerowsecurity)`,
    );
    expect(unforced).toEqual([]);
  });

  it("gives discrepancies a direct owner column, not only a join", async () => {
    const [qual] = await column(
      db,
      `select qual from pg_policies where tablename = 'discrepancies' and cmd = 'SELECT'`,
    );
    expect(qual).toMatch(/user_id/);
  });
});
