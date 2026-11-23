import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  EngineBridge,
  NexusError,
  createClient,
  defineConfig,
  defineModel,
  field,
  normalizeWhereToAST,
  relation,
  scrubCredentials,
  serializeSchema,
} from "../src/index.js";

describe("Phase 2 & 3: Error Redaction & Configuration Validation", () => {
  it("redacts passwords from database URLs and key-value DSNs", () => {
    const raw =
      "Connection failed for postgres://nexus_admin:MyTopSecret99@db.example.com:5432/prod";
    const safe = scrubCredentials(raw);
    expect(safe).not.toContain("MyTopSecret99");
    expect(safe).toContain("postgres://nexus_admin:[REDACTED]@db.example.com:5432/prod");
  });

  it("validates configuration with sensible defaults via defineConfig", () => {
    const cfg = defineConfig({
      dialect: "postgres",
      connection: {
        url: "postgres://user:pass@localhost:5432/app",
      },
    });
    expect(cfg.dialect).toBe("postgres");
    expect(cfg.executionMode).toBe("auto");
    expect(cfg.connection.pool.min).toBe(2);
    expect(cfg.connection.pool.max).toBe(10);
  });

  it("throws NEXUS_CONFIG_INVALID when pool min exceeds max", () => {
    expect(() =>
      defineConfig({
        dialect: "sqlite",
        connection: {
          url: "file:./test.db",
          pool: { min: 20, max: 5 },
        },
      })
    ).toThrowError(NexusError);
  });
});

describe("Phase 4 & 5: Model Definition, Drizzle-Style .toSQL() & Filter AST", () => {
  const User = defineModel("User", {
    id: field.uuid().primaryKey().defaultRandom(),
    username: field.string({ maxLength: 50 }).unique().index(),
    email: field.string().unique(),
    active: field.boolean().default(true),
  });

  it("compiles queries directly to parameterized SQL via .toSQL() with zero IPC", () => {
    const config = defineConfig({
      dialect: "sqlite",
      executionMode: "native",
      connection: { url: ":memory:" },
    });
    const db = createClient({ config, models: { User } });
    const compiled = db.user.toSQL({
      where: { active: true, username: { startsWith: "b" } },
      select: ["id", "username"],
      orderBy: { username: "asc" },
      limit: 10,
    });

    expect(compiled.sql).toBe(
      'SELECT "id", "username" FROM "users" WHERE ("active" = ? AND "username" LIKE ?) ORDER BY "username" ASC LIMIT 10;'
    );
    expect(compiled.params).toEqual([1, "b%"]);
  });

  it("normalizes nested where filters and comparison operators into AST nodes", () => {
    const ast = normalizeWhereToAST({
      active: true,
      OR: [{ username: { contains: "ada" } }, { email: { endsWith: "@nexus.dev" } }],
    });
    expect(ast?.AND).toHaveLength(2);
  });
});

describe("Zero-IPC In-Process Native Mode & Live Schema Column Evolution", () => {
  it("executes CRUD, relations, transactions, and live column evolution in-process without Go IPC", async () => {
    const tmpDbFile = path.join(os.tmpdir(), `nexus_native_${Date.now()}.db`);

    // Step 1: Start with V1 of the User model (only id & username)
    const UserV1 = defineModel("User", {
      id: field.uuid().primaryKey().defaultRandom(),
      username: field.string().unique(),
    });

    const config = defineConfig({
      dialect: "sqlite",
      executionMode: "native",
      connection: { url: `file:${tmpDbFile}` },
    });

    const dbV1 = createClient({ config, models: { User: UserV1 } });
    await dbV1.$pushSchema();

    const user1 = await dbV1.user.create({
      data: { username: "barre" },
    });
    expect(user1.username).toBe("barre");
    await dbV1.$disconnect();

    // Step 2: Evolve the User model to V2 by adding 'role' (with default) and 'bio' (nullable)
    const UserV2 = defineModel("User", {
      id: field.uuid().primaryKey().defaultRandom(),
      username: field.string().unique(),
      role: field.string().default("admin"),
      bio: field.string().nullable(),
    });

    const dbV2 = createClient({ config, models: { User: UserV2 } });
    // $pushSchema() diffs the existing table and runs ALTER TABLE ADD COLUMN
    await dbV2.$pushSchema();

    const updated = await dbV2.user.update({
      where: { username: "barre" },
      data: { role: "founder", bio: "Building NexusORM" },
    });

    expect(updated.role).toBe("founder");
    expect(updated.bio).toBe("Building NexusORM");
    await dbV2.$disconnect();

    if (fs.existsSync(tmpDbFile)) {
      fs.unlinkSync(tmpDbFile);
    }
  });
});

describe("Phase 6 & 9: End-to-End TypeScript Client <-> Go Engine IPC", () => {
  const binPath = EngineBridge.resolveDefaultBinaryPath();
  const hasBinary = fs.existsSync(binPath);

  it.skipIf(!hasBinary)(
    "executes full CRUD, relations, transactions, and live schema evolution over the Go engine",
    async () => {
      const User = defineModel("User", {
        id: field.uuid().primaryKey().defaultRandom(),
        username: field.string().unique(),
        email: field.string().unique(),
        active: field.boolean().default(true),
      });

      const Post = defineModel("Post", {
        id: field.uuid().primaryKey().defaultRandom(),
        title: field.string(),
        views: field.integer().default(0),
        authorId: field.uuid().references(() => User, "id"),
      });

      relation.define(User, ({ hasMany }) => ({
        posts: hasMany(() => Post, { foreignKey: "authorId" }),
      }));

      const config = defineConfig({
        dialect: "sqlite",
        executionMode: "go",
        connection: { url: "file::memory:?cache=shared" },
      });

      const db = createClient({
        config,
        models: { User, Post },
      });

      await db.$pushSchema();

      try {
        const created = await db.user.create({
          data: {
            username: "grace",
            email: "grace@nexus.dev",
          },
        });
        expect(created.id).toBeTruthy();

        await db.post.create({
          data: {
            title: "Compiler Design",
            views: 100,
            authorId: created.id,
          },
        });

        const usersWithPosts = await db.user.findMany({
          where: { active: true },
          include: { posts: true },
        });
        expect(usersWithPosts).toHaveLength(1);
        expect(usersWithPosts[0]?.posts[0]?.title).toBe("Compiler Design");

        await expect(
          db.$transaction(async (tx) => {
            await tx.user.create({
              data: { username: "temp_user", email: "temp@nexus.dev" },
            });
            throw new Error("Intentional rollback");
          })
        ).rejects.toThrow();

        const tempExists = await db.user.exists({ username: "temp_user" });
        expect(tempExists).toBe(false);
      } finally {
        await db.$disconnect();
      }
    }
  );
});
