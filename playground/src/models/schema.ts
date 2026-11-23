import { defineModel, field, relation } from "@nexus-orm/core";

export const User = defineModel("User", {
  id: field.uuid().primaryKey().defaultRandom(),
  username: field.string({ maxLength: 64 }).unique().index(),
  email: field.string().unique(),
  active: field.boolean().default(true),
  createdAt: field.date().defaultNow(),
});

export const Post = defineModel("Post", {
  id: field.uuid().primaryKey().defaultRandom(),
  title: field.string(),
  views: field.integer().default(0),
  authorId: field.uuid().references(() => User, "id", { onDelete: "CASCADE" }),
  createdAt: field.date().defaultNow(),
});

relation.define(User, ({ hasMany }) => ({
  posts: hasMany(() => Post, { foreignKey: "authorId" }),
}));

relation.define(Post, ({ belongsTo }) => ({
  author: belongsTo(() => User, { foreignKey: "authorId" }),
}));
