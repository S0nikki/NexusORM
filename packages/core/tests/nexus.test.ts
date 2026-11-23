import fs from "node:fs";
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
    expect(cfg.connection.pool.min).toBe(2);
    expect(cfg.connection.pool.max).toBe(10);
    expect(cfg.models).toBe("./src/models");
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

describe("Phase 4 & 5: Model Definition, Schema Serialization & Filter AST", () => {
  const User = defineModel("User", {
    id: field.uuid().primaryKey().defaultRandom(),
    username: field.string({ maxLength: 50 }).unique().index(),
    email: field.string().unique(),
    active: field.boolean().default(true),
    bio: field.string().nullable(),
    createdAt: field.date().defaultNow(),
  });

  const Post = defineModel("Post", {
    id: field.uuid().primaryKey().defaultRandom(),
    title: field.string(),
    views: field.integer().default(0),
    authorId: field.uuid().references(() => User, "id", { onDelete: "CASCADE" }),
  });

  relation.define(User, ({ hasMany }) => ({
    posts: hasMany(() => Post, { foreignKey: "authorId" }),
  }));

  relation.define(Post, ({ belongsTo }) => ({
    author: belongsTo(() => User, { foreignKey: "authorId" }),
  }));

  it("serializes models and relations into the Go engine ISR manifest", () => {
    const manifest = serializeSchema([User, Post]);
    expect(manifest.models).toHaveLength(2);
    const userSchema = manifest.models.find((m) => m.name === "User")!;
    expect(userSchema.tableName).toBe("users");
    expect(userSchema.fields.find((f) => f.name === "id")?.defaultKind).toBe("uuid");
    expect(userSchema.relations[0]?.name).toBe("posts");
    expect(userSchema.relations[0]?.kind).toBe("oneToMany");
  });

  it("normalizes nested where filters and comparison operators into AST nodes", () => {
    const ast = normalizeWhereToAST({
      active: true,
      OR: [{ username: { contains: "ada" } }, { email: { endsWith: "@nexus.dev" } }],
    });
    expect(ast?.AND).toHaveLength(2);
  });
});

describe("Phase 6 & 9: End-to-End TypeScript Client <-> Go Engine IPC", () => {
  const binPath = EngineBridge.resolveDefaultBinaryPath();
  const hasBinary = fs.existsSync(binPath);

  it.skipIf(!hasBinary)(
    "executes full CRUD, relations, and transactions over persistent stdio JSON-RPC",
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
        expect(created.username).toBe("grace");

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
        expect(usersWithPosts[0]?.posts).toHaveLength(1);
        expect(usersWithPosts[0]?.posts[0]?.title).toBe("Compiler Design");

        const total = await db.user.count({ where: { active: true } });
        expect(total).toBe(1);

        // Verify transaction rollback
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
