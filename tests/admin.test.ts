/**
 * The admin gate, TypeScript side.
 *
 * Read services/admin.ts's header first: the real enforcement is in SQL, and
 * these functions exist to turn "you got zero rows" into "you are not an admin".
 * So what is tested here is the gate's DECISION LOGIC — who is let through, what
 * an audit row contains, what a rejection reveals — with the database stubbed.
 *
 * A test that stubbed Postgres and then claimed RLS works would be worse than no
 * test. docs/GAPS.md S1 says plainly that no policy has ever been executed, and
 * nothing here contradicts that.
 */
import { describe, expect, it, vi, beforeEach, afterEach, beforeAll } from "vitest";
import { randomBytes } from "node:crypto";

beforeAll(() => {
  process.env.SUPABASE_URL ??= "https://example.supabase.co";
  process.env.SUPABASE_ANON_KEY ??= "eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoiYW5vbiJ9.sig";
  process.env.SUPABASE_SERVICE_ROLE_KEY ??= randomBytes(24).toString("hex");
});

const USER = "11111111-1111-4111-8111-111111111111";

/** A JWT whose `sub` is USER. Unsigned — userDb only decodes, Postgres verifies. */
function tokenFor(sub: string): string {
  const part = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${part({ alg: "HS256" })}.${part({ sub })}.signature`;
}

const ctx = { userId: USER, accessToken: tokenFor(USER) };

/** Captures every table/view touched and every row inserted. */
interface Recorder {
  selected: string[];
  inserted: { table: string; row: Record<string, unknown> }[];
}

function stubDb(roles: string[], boardRows: unknown[] = []) {
  const recorder: Recorder = { selected: [], inserted: [] };

  const client = {
    from(table: string) {
      return {
        select() {
          recorder.selected.push(table);
          const rows = table === "user_roles" ? roles.map((role) => ({ role })) : boardRows;
          const result = { data: rows, error: null };
          return Object.assign(Promise.resolve(result), {
            eq: () => Promise.resolve(result),
          });
        },
        insert(row: Record<string, unknown>) {
          recorder.inserted.push({ table, row });
          return Promise.resolve({ data: null, error: null });
        },
        delete() {
          return { eq: () => ({ eq: () => Promise.resolve({ data: null, error: null }) }) };
        },
      };
    },
  };

  return { recorder, client };
}

async function withStub(
  roles: string[],
  boardRows: unknown[],
  body: (recorder: Recorder) => Promise<void>,
) {
  const { recorder, client } = stubDb(roles, boardRows);
  const db = await import("../services/db.js");
  const userSpy = vi.spyOn(db, "userDb").mockReturnValue(client as never);
  const adminSpy = vi.spyOn(db, "adminDb").mockReturnValue(client as never);
  try {
    await body(recorder);
  } finally {
    userSpy.mockRestore();
    adminSpy.mockRestore();
  }
}

beforeEach(() => vi.resetModules());
afterEach(() => vi.restoreAllMocks());

describe("requireRole", () => {
  it("lets an admin through", async () => {
    await withStub(["admin"], [], async () => {
      const { requireRole } = await import("../services/admin.js");
      await expect(requireRole(ctx, "admin")).resolves.toMatchObject({ roles: ["admin"] });
    });
  });

  it("refuses a user with no roles at all", async () => {
    await withStub([], [], async () => {
      const { requireRole } = await import("../services/admin.js");
      await expect(requireRole(ctx, "admin")).rejects.toThrow(/requires the admin role/);
    });
  });

  it("refuses a reviewer asking for admin — reviewer does not imply admin", async () => {
    await withStub(["reviewer"], [], async () => {
      const { requireRole } = await import("../services/admin.js");
      await expect(requireRole(ctx, "admin")).rejects.toThrow(/requires the admin role/);
    });
  });

  it("lets an admin through a reviewer gate — admin does imply reviewer", async () => {
    await withStub(["admin"], [], async () => {
      const { requireRole } = await import("../services/admin.js");
      await expect(requireRole(ctx, "reviewer")).resolves.toBeTruthy();
    });
  });

  it("does not say who is an admin, or that the board exists", async () => {
    await withStub([], [], async () => {
      const { requireRole } = await import("../services/admin.js");
      const message = await requireRole(ctx, "admin").catch((e: Error) => e.message);
      // An error naming the board or another user is an enumeration oracle.
      expect(message).not.toMatch(/admin_|merchant|user_roles|[0-9a-f]{8}-/);
    });
  });
});

describe("boards", () => {
  it("refuses every board to a user with no role", async () => {
    await withStub([], [{ kind: "receipt_ocr" }], async () => {
      const admin = await import("../services/admin.js");
      for (const board of [
        admin.modelAccuracyBoard,
        admin.merchantShortageBoard,
        admin.ingestHealthBoard,
        admin.corpusCoverageBoard,
      ]) {
        await expect(board(ctx), board.name).rejects.toThrow(/requires the/);
      }
    });
  });

  it("never queries the board view when the gate rejects", async () => {
    await withStub([], [{ kind: "receipt_ocr" }], async (recorder) => {
      const { modelAccuracyBoard } = await import("../services/admin.js");
      await modelAccuracyBoard(ctx).catch(() => undefined);
      // Only the role lookup happened. The view was never touched.
      expect(recorder.selected).toEqual(["user_roles"]);
    });
  });

  it("gives a reviewer the accuracy board but not the shortage board", async () => {
    await withStub(["reviewer"], [{ kind: "receipt_ocr", calls: 3 }], async () => {
      const admin = await import("../services/admin.js");
      await expect(admin.modelAccuracyBoard(ctx)).resolves.toHaveLength(1);
      await expect(admin.merchantShortageBoard(ctx)).rejects.toThrow(/requires the admin role/);
    });
  });

  it("reads the admin view, never the underlying tables", async () => {
    await withStub(["admin"], [{ merchant_name_key: "x" }], async (recorder) => {
      const { merchantShortageBoard } = await import("../services/admin.js");
      await merchantShortageBoard(ctx);
      expect(recorder.selected).toContain("admin_merchant_shortage_index");
      // Going direct to `orders` would bypass the n>=20 gate that lives in the view.
      expect(recorder.selected).not.toContain("orders");
      expect(recorder.selected).not.toContain("discrepancies");
    });
  });
});

describe("admin audit trail", () => {
  it("records every privileged read", async () => {
    await withStub(["admin"], [{ merchant_name_key: "x" }], async (recorder) => {
      const { merchantShortageBoard } = await import("../services/admin.js");
      await merchantShortageBoard(ctx);

      const audit = recorder.inserted.filter((i) => i.table === "admin_audit_log");
      expect(audit).toHaveLength(1);
      expect(audit[0]?.row).toMatchObject({ actor_id: USER, action: "read_merchant_shortage" });
    });
  });

  it("logs counts and identifiers, never the rows themselves", async () => {
    const sensitive = [{ merchant_name_key: "joe's pizza", merchant_addr_key: "1 main st" }];
    await withStub(["admin"], sensitive, async (recorder) => {
      const { merchantShortageBoard } = await import("../services/admin.js");
      await merchantShortageBoard(ctx);

      // An audit log that copies the data it audits doubles the blast radius of
      // reading it.
      const detail = JSON.stringify(recorder.inserted.at(-1)?.row);
      expect(detail).not.toContain("joe's pizza");
      expect(detail).not.toContain("1 main st");
      expect(detail).toContain('"rows":1');
    });
  });

  it("writes no audit row when the gate rejects", async () => {
    await withStub([], [], async (recorder) => {
      const { ingestHealthBoard } = await import("../services/admin.js");
      await ingestHealthBoard(ctx).catch(() => undefined);
      expect(recorder.inserted).toHaveLength(0);
    });
  });
});

describe("grantRole", () => {
  it("goes through the service role, never the user's session", async () => {
    const { recorder, client } = stubDb([]);
    const db = await import("../services/db.js");
    const adminSpy = vi.spyOn(db, "adminDb").mockReturnValue(client as never);
    const userSpy = vi.spyOn(db, "userDb").mockReturnValue(client as never);

    const { grantRole } = await import("../services/admin.js");
    await grantRole({ userId: USER, role: "reviewer", reason: "eval triage", grantedBy: null });

    // `user_roles` holds no write grant for `authenticated`, so a user-session
    // client could not have done this even if it had been used.
    expect(adminSpy).toHaveBeenCalledWith("role_administration");
    expect(userSpy).not.toHaveBeenCalled();
    expect(recorder.inserted[0]?.row).toMatchObject({
      user_id: USER,
      role: "reviewer",
      reason: "eval triage",
      granted_by: null,
    });

    adminSpy.mockRestore();
    userSpy.mockRestore();
  });

  it("refuses a grant with no stated reason", async () => {
    const { grantRole } = await import("../services/admin.js");
    await expect(
      grantRole({ userId: USER, role: "admin", reason: "  ", grantedBy: null }),
    ).rejects.toThrow(/stated reason/);
  });
});
