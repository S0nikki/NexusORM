import { createClient, loadConfig } from "@nexus-orm/core";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Post, User } from "./src/models/schema.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  const config = await loadConfig(__dirname);
  const db = createClient({
    config,
    models: { User, Post },
  });

  // Sync tables to playground.db
  await db.$pushSchema();

  // Clean previous demo runs
  await db.post.deleteMany();
  await db.user.deleteMany();

  // 1. Create a user inside a transaction along with two posts
  const createdUser = await db.$transaction(async (tx) => {
    const user = await tx.user.create({
      data: {
        username: "barre",
        email: "barre@nexus.local",
      },
    });

    await tx.post.createMany({
      data: [
        { title: "Running Nexus on Bun", views: 120, authorId: user.id },
        { title: "Go + TypeScript IPC Architecture", views: 85, authorId: user.id },
      ],
    });

    return user;
  });

  console.log("Created user:", createdUser);

  // 2. Query back with eager-loaded relations
  const users = await db.user.findMany({
    where: { active: true },
    include: {
      posts: {
        orderBy: { views: "desc" },
      },
    },
  });

  console.log("\nUsers with eager-loaded posts:");
  console.dir(users, { depth: null });

  await db.$disconnect();
}

main().catch(console.error);
