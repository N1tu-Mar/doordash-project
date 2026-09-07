/**
 * Static checks over the migration SQL.
 *
 * These do NOT run Postgres — docs/GAPS.md S1 is explicit that no migration has
 * ever been executed, and a test that pretended otherwise would be worse than no
 * test. What they check is the class of mistake that is invisible in review and
 * catastrophic in production: a table with RLS enabled but no policy, an admin
 * view without its role gate, a function without a pinned search_path, a write
 * grant on a table that must stay read-only.
 *
 * A green run here means "the SQL says what we think it says". It does not mean
 * the SQL runs. Those are different claims and only one of them is being made.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const DIR = "supabase/migrations";
const FILES = readdirSync(DIR)
  .filter((f) => f.endsWith(".sql"))
  .sort();
const SQL = FILES.map((f) => readFileSync(join(DIR, f), "utf8")).join("\n");

/** Every table that holds per-user data and must therefore be RLS-protected. */
const USER_DATA_TABLES = [
  "orders",
  "order_items",
  "order_fee_lines",
  "discrepancies",
  "model_calls",
  "gmail_ingest_consents",
  "gmail_messages",
  "user_roles",
  "admin_audit_log",
];

describe("migration hygiene", () => {
  it("applies in a stable, gapless order", () => {
    expect(FILES).toEqual([
      "0001_init.sql",
      "0002_gmail_ingest.sql",
      "0003_security_hardening.sql",
      "0004_roles_and_admin.sql",
      "0005_schema_corrections.sql",
    ]);
  });

  it("enables AND forces row level security on every user-data table", () => {
    for (const table of USER_DATA_TABLES) {
      expect(SQL, `${table}: enable`).toMatch(
        new RegExp(`alter table ${table}\\s+enable row level security`, "i"),
      );
      // FORCE is what makes policies apply to the table owner too.
      expect(SQL, `${table}: force`).toMatch(
        new RegExp(`alter table ${table}\\s+force\\s+row level security`, "i"),
      );
    }
  });

  it("revokes everything from anon on every user-data table", () => {
    // RLS filters rows; grants decide whether the statement may be issued at
    // all. Relying on policies alone to come back empty is one missing `using`
    // clause away from a leak.
    for (const table of USER_DATA_TABLES) {
      expect(SQL, table).toMatch(new RegExp(`revoke all on[^;]*\\b${table}\\b[^;]*from[^;]*anon`, "is"));
    }
  });

  /**
   * Every `create or replace function` body in the whole migration set, keyed by
   * name, keeping the LAST definition.
   *
   * The last one is the one that applies. It matters here: 0001 defined its
   * trigger functions without a pinned search_path and 0003 redefines them with
   * one, so checking the first occurrence would fail on SQL that is actually
   * correct — and checking "any occurrence" would pass on SQL that is not.
   */
  function finalFunctionBodies(): Map<string, string> {
    const bodies = new Map<string, string>();
    const pattern = /create or replace function\s+([\w.]+)\s*\(([\s\S]*?)\$\$;/gi;
    for (const match of SQL.matchAll(pattern)) {
      const name = match[1] ?? "?";
      bodies.set(name, match[0]);
    }
    return bodies;
  }

  it("pins search_path on the definition of every function that survives", () => {
    const bodies = finalFunctionBodies();
    expect(bodies.size).toBeGreaterThan(5);
    for (const [name, body] of bodies) {
      // A mutable search_path lets an attacker-created schema shadow the
      // operators a function resolves — the classic Postgres escalation.
      expect(body, `${name} must pin search_path`).toMatch(/set search_path\s*=/i);
    }
  });

  it("supersedes every unpinned 0001 function later in the migration set", () => {
    // 0001 shipped these without a pinned search_path. They must not still be
    // the last word on their own name.
    const bodies = finalFunctionBodies();
    for (const name of ["reject_immutable_column_change", "reject_detected_items_change"]) {
      const body = bodies.get(name);
      expect(body, `${name} should exist`).toBeDefined();
      expect(body, `${name} final definition`).toMatch(/set search_path\s*=/i);
    }
  });

  it("marks every SECURITY DEFINER function stable and search_path-pinned", () => {
    const definers = [...finalFunctionBodies()].filter(([, body]) =>
      /security definer/i.test(body),
    );
    // is_admin / is_reviewer / has_role. If this drops to zero the role
    // predicates have quietly become invoker-rights and RLS recursion is back.
    expect(definers.length).toBe(3);
    for (const [name, body] of definers) {
      expect(body, name).toMatch(/set search_path\s*=/i);
      expect(body, `${name} should be stable, not volatile`).toMatch(/\bstable\b/i);
      // No user-supplied identifier reaches these; they read auth.uid() only.
      expect(body, `${name} must not take a user id argument`).not.toMatch(/p_user_id/i);
    }
  });
});

describe("privilege escalation is not expressible", () => {
  it("grants users only SELECT on user_roles", () => {
    expect(SQL).toMatch(/revoke all on user_roles from anon, authenticated/i);
    expect(SQL).toMatch(/grant select on user_roles to authenticated/i);
  });

  it("defines no insert, update or delete policy on user_roles", () => {
    const policies = SQL.match(/create policy \w+ on user_roles for (\w+)/gi) ?? [];
    expect(policies.length).toBeGreaterThan(0);
    for (const policy of policies) {
      expect(policy.toLowerCase(), policy).toContain("for select");
    }
  });

  it("rejects any user_roles write arriving with a live auth.uid()", () => {
    // Defence in depth behind the missing grant: even if someone later adds a
    // write policy, a user session still cannot escalate.
    expect(SQL).toMatch(/reject_user_role_self_service/);
    expect(SQL).toMatch(/auth\.uid\(\)\) is not null then\s*\n\s*raise exception/);
    expect(SQL).toMatch(
      /create trigger user_roles_no_self_service\s+before insert or update or delete on user_roles/i,
    );
  });
});

describe("admin boards are gated in SQL, not in TypeScript", () => {
  const BOARDS = [
    "admin_model_accuracy",
    "admin_merchant_shortage_index",
    "admin_ingest_health",
    "admin_corpus_coverage",
  ];

  it("every admin view carries a role predicate in its own body", () => {
    for (const view of BOARDS) {
      const start = SQL.indexOf(`create or replace view ${view}`);
      expect(start, view).toBeGreaterThan(-1);
      const body = SQL.slice(start, SQL.indexOf(";", start));
      // Without this the view runs security_invoker = off and returns every
      // user's rows to anybody who can name it.
      expect(body, `${view} needs is_admin()/is_reviewer() in its WHERE`).toMatch(
        /where public\.is_(admin|reviewer)\(\)/,
      );
    }
  });

  it("keeps admin views out of anon's reach", () => {
    for (const view of BOARDS) {
      expect(SQL, view).toMatch(new RegExp(`revoke all on[^;]*\\b${view}\\b[^;]*from[^;]*anon`, "is"));
    }
  });

  it("keeps the n >= 20 shortage gate in SQL where no caller can route around it", () => {
    const start = SQL.indexOf("create or replace view admin_merchant_shortage_index");
    const body = SQL.slice(start, SQL.indexOf(";", start));
    expect(body).toMatch(/having count\(distinct o\.id\) >= 20/i);
    // Twenty orders from one household is one household's experience.
    expect(body).toMatch(/count\(distinct o\.user_id\) >= 5/i);
  });
});

describe("append-only tables are append-only for everyone", () => {
  it("blocks model_calls mutation by trigger, not only by policy", () => {
    // A policy binds `authenticated`. The service role bypasses RLS entirely,
    // so the audit trail needs a trigger to actually be append-only.
    expect(SQL).toMatch(
      /create trigger model_calls_append_only\s+before update or delete on model_calls/i,
    );
    expect(SQL).toMatch(
      /create trigger admin_audit_append_only\s+before update or delete on admin_audit_log/i,
    );
  });

  it("grants model_calls no update or delete", () => {
    const grant = /grant ([\w, ]+?)\s+on\s+model_calls\s+to authenticated/i.exec(SQL)?.[1] ?? "";
    expect(grant).toContain("select");
    expect(grant).toContain("insert");
    expect(grant).not.toContain("update");
    expect(grant).not.toContain("delete");
  });
});

describe("storage artifacts", () => {
  it("creates both buckets private", () => {
    const insert = SQL.slice(
      SQL.indexOf("insert into storage.buckets"),
      SQL.indexOf("on conflict (id) do update"),
    );
    expect(insert).toContain("'raw-receipts'");
    expect(insert).toContain("'delivered-photos'");
    expect(insert).not.toMatch(/,\s*true\s*,/);
  });

  it("scopes object policies to the caller's own folder", () => {
    expect(SQL).toMatch(/\(storage\.foldername\(name\)\)\[1\] = auth\.uid\(\)::text/);
  });

  it("defines no update or delete policy on artifact objects", () => {
    // Raw artifacts are the corpus. A parser bug must not be able to destroy
    // the evidence a claim was built on.
    const policies = SQL.match(/create policy shorted_artifacts_\w+ on storage\.objects for (\w+)/gi) ?? [];
    expect(policies.length).toBe(2);
    for (const policy of policies) {
      expect(policy.toLowerCase()).toMatch(/for (select|insert)/);
    }
  });
});

describe("the schema agrees with core/money.ts", () => {
  it("stores every FeeKind the arithmetic branches on", () => {
    const table = SQL.slice(
      SQL.indexOf("create table if not exists order_fee_lines"),
      SQL.indexOf("create index if not exists order_fee_lines_order_idx"),
    );
    const check = /kind text not null check \(kind in\s*\n?\s*\(([^)]*)\)\)/.exec(table)?.[1] ?? "";
    for (const kind of ["proportional", "per_delivery", "threshold", "passthrough", "unknown"]) {
      expect(check, kind).toContain(`'${kind}'`);
    }
  });

  it("stores the whole owed breakdown, not just a total", () => {
    for (const column of ["owed_with_tip_cents", "owed_maximum_cents", "owed_components"]) {
      expect(SQL, column).toContain(column);
    }
  });

  it("derives fees_cents from the fee lines inside the transaction", () => {
    const start = SQL.indexOf("create or replace function insert_order_full");
    const body = SQL.slice(start, SQL.indexOf("$$;", start));
    expect(body).toMatch(/select coalesce\(sum\(\(fee->>'cents'\)::int\), 0\) into v_fees_cents/);
    // Not a parameter: the scalar and the lines cannot be made to disagree.
    expect(body).not.toMatch(/p_fees_cents/);
  });

  it("takes user_id from auth.uid(), never from an argument", () => {
    const start = SQL.indexOf("create or replace function insert_order_full");
    const signature = SQL.slice(start, SQL.indexOf(") returns uuid", start));
    expect(signature).not.toMatch(/p_user_id/);
    expect(SQL.slice(start)).toMatch(/v_user_id uuid := \(select auth\.uid\(\)\)/);
  });

  it("supersedes the fee-line-less insert rather than leaving it callable", () => {
    expect(SQL).toMatch(/drop function if exists insert_order_with_items/i);
  });
});
