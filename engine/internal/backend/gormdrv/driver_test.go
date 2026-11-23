package gormdrv_test

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"nexus/engine/internal/backend/gormdrv"
	"nexus/engine/internal/migrator"
	"nexus/engine/internal/protocol"
	"nexus/engine/internal/registry"
)

func setupTestDriver(t *testing.T) *gormdrv.GormDriver {
	reg := registry.NewRegistry()
	drv := gormdrv.NewGormDriver(reg)
	ctx := context.Background()

	err := drv.Connect(ctx, protocol.ConnectionConfig{
		Dialect: "sqlite",
		URL:     "file::memory:?cache=shared",
	})
	if err != nil {
		t.Fatalf("failed to connect to sqlite memory db: %v", err)
	}

	manifest := protocol.SchemaManifest{
		Models: []protocol.ModelSchema{
			{
				Name: "User",
				Fields: []protocol.FieldSchema{
					{Name: "id", Type: "uuid", PrimaryKey: true, DefaultKind: "uuid"},
					{Name: "username", Type: "string", Unique: true},
					{Name: "email", Type: "string", Unique: true},
					{Name: "active", Type: "boolean", DefaultKind: "static", DefaultValue: true},
				},
				Relations: []protocol.RelationSchema{
					{Name: "posts", Kind: "oneToMany", Target: "Post", ForeignKey: "authorId", References: "id"},
				},
			},
			{
				Name: "Post",
				Fields: []protocol.FieldSchema{
					{Name: "id", Type: "uuid", PrimaryKey: true, DefaultKind: "uuid"},
					{Name: "title", Type: "string"},
					{Name: "views", Type: "integer", DefaultKind: "static", DefaultValue: 0},
					{Name: "authorId", Type: "uuid", References: &protocol.ReferenceSchema{Model: "User", Column: "id", OnDelete: "CASCADE"}},
				},
				Relations: []protocol.RelationSchema{
					{Name: "author", Kind: "manyToOne", Target: "User", ForeignKey: "authorId", References: "id"},
				},
			},
		},
	}

	if err := drv.RegisterSchema(ctx, manifest); err != nil {
		t.Fatalf("register schema failed: %v", err)
	}
	if err := drv.PushSchema(ctx); err != nil {
		t.Fatalf("push schema failed: %v", err)
	}
	return drv
}

func TestCRUDAndRelations(t *testing.T) {
	drv := setupTestDriver(t)
	defer drv.Close()
	ctx := context.Background()

	userRes, err := drv.ExecuteQuery(ctx, protocol.QueryAST{
		Model:     "User",
		Operation: "create",
		Data: map[string]any{
			"username": "ada",
			"email":    "ada@nexus.dev",
		},
	})
	if err != nil {
		t.Fatalf("create user failed: %v", err)
	}
	userID, ok := userRes.Row["id"].(string)
	if !ok || userID == "" {
		t.Fatalf("expected generated UUID id, got: %v", userRes.Row["id"])
	}

	_, err = drv.ExecuteQuery(ctx, protocol.QueryAST{
		Model:     "Post",
		Operation: "create",
		Data: map[string]any{
			"title":    "Nexus Architecture",
			"views":    42,
			"authorId": userID,
		},
	})
	if err != nil {
		t.Fatalf("create post failed: %v", err)
	}

	findRes, err := drv.ExecuteQuery(ctx, protocol.QueryAST{
		Model:     "User",
		Operation: "findMany",
		Where:     &protocol.FilterNode{Field: "username", Op: "eq", Value: "ada"},
		Include: map[string]protocol.IncludeNode{
			"posts": {},
		},
	})
	if err != nil {
		t.Fatalf("findMany with include failed: %v", err)
	}
	if len(findRes.Rows) != 1 {
		t.Fatalf("expected 1 user row, got %d", len(findRes.Rows))
	}
	posts, ok := findRes.Rows[0]["posts"].([]map[string]any)
	if !ok || len(posts) != 1 {
		t.Fatalf("expected 1 eager-loaded post, got: %#v", findRes.Rows[0]["posts"])
	}

	txID, err := drv.BeginTx(ctx, protocol.TxOptions{TimeoutMs: 5000})
	if err != nil {
		t.Fatalf("begin tx failed: %v", err)
	}
	_, err = drv.ExecuteQuery(ctx, protocol.QueryAST{
		TxID:      txID,
		Model:     "User",
		Operation: "create",
		Data: map[string]any{
			"username": "rolled_back_user",
			"email":    "rollback@nexus.dev",
		},
	})
	if err != nil {
		t.Fatalf("create in tx failed: %v", err)
	}
	if err := drv.RollbackTx(ctx, txID); err != nil {
		t.Fatalf("rollback failed: %v", err)
	}

	existsRes, err := drv.ExecuteQuery(ctx, protocol.QueryAST{
		Model:     "User",
		Operation: "exists",
		Where:     &protocol.FilterNode{Field: "username", Op: "eq", Value: "rolled_back_user"},
	})
	if err != nil || existsRes.Exists {
		t.Fatalf("expected rolled back user not to exist")
	}
}

func TestSchemaPushColumnEvolution(t *testing.T) {
	reg := registry.NewRegistry()
	drv := gormdrv.NewGormDriver(reg)
	defer drv.Close()
	ctx := context.Background()

	_ = drv.Connect(ctx, protocol.ConnectionConfig{Dialect: "sqlite", URL: ":memory:"})

	// V1 of User model: only id and username
	v1 := protocol.SchemaManifest{
		Models: []protocol.ModelSchema{
			{
				Name: "User",
				Fields: []protocol.FieldSchema{
					{Name: "id", Type: "uuid", PrimaryKey: true, DefaultKind: "uuid"},
					{Name: "username", Type: "string", Unique: true},
				},
			},
		},
	}
	if err := drv.RegisterSchema(ctx, v1); err != nil {
		t.Fatalf("v1 register failed: %v", err)
	}
	if err := drv.PushSchema(ctx); err != nil {
		t.Fatalf("v1 push failed: %v", err)
	}

	// Insert a record under V1
	_, err := drv.ExecuteQuery(ctx, protocol.QueryAST{
		Model:     "User",
		Operation: "create",
		Data:      map[string]any{"username": "linus"},
	})
	if err != nil {
		t.Fatalf("v1 create failed: %v", err)
	}

	// V2 of User model: add 'role' (with default) and 'points' (nullable integer)
	v2 := protocol.SchemaManifest{
		Models: []protocol.ModelSchema{
			{
				Name: "User",
				Fields: []protocol.FieldSchema{
					{Name: "id", Type: "uuid", PrimaryKey: true, DefaultKind: "uuid"},
					{Name: "username", Type: "string", Unique: true},
					{Name: "role", Type: "string", DefaultKind: "static", DefaultValue: "member"},
					{Name: "points", Type: "integer", Nullable: true},
				},
			},
		},
	}
	if err := drv.RegisterSchema(ctx, v2); err != nil {
		t.Fatalf("v2 register failed: %v", err)
	}
	if err := drv.PushSchema(ctx); err != nil {
		t.Fatalf("v2 push failed: %v", err)
	}

	// Update existing row with new columns
	updated, err := drv.ExecuteQuery(ctx, protocol.QueryAST{
		Model:     "User",
		Operation: "update",
		Where:     &protocol.FilterNode{Field: "username", Op: "eq", Value: "linus"},
		Data:      map[string]any{"role": "maintainer", "points": 99},
	})
	if err != nil {
		t.Fatalf("v2 update with new columns failed: %v", err)
	}
	if updated.Row["role"] != "maintainer" {
		t.Fatalf("expected updated role 'maintainer', got %v", updated.Row["role"])
	}
}

func TestMigrationsLifecycle(t *testing.T) {
	reg := registry.NewRegistry()
	drv := gormdrv.NewGormDriver(reg)
	defer drv.Close()
	ctx := context.Background()

	_ = drv.Connect(ctx, protocol.ConnectionConfig{Dialect: "sqlite", URL: ":memory:"})
	_ = drv.RegisterSchema(ctx, protocol.SchemaManifest{
		Models: []protocol.ModelSchema{
			{
				Name: "Tag",
				Fields: []protocol.FieldSchema{
					{Name: "id", Type: "integer", PrimaryKey: true, AutoIncrement: true},
					{Name: "name", Type: "string", Unique: true},
				},
			},
		},
	})

	tmpDir := t.TempDir()
	mig := migrator.NewMigrator(drv)

	filePath, _, err := mig.GenerateMigrationFile(tmpDir, "init_tags")
	if err != nil {
		t.Fatalf("generate migration failed: %v", err)
	}
	if filepath.Dir(filePath) != tmpDir {
		t.Fatalf("expected migration in temp dir")
	}

	applied, err := mig.ApplyUp(ctx, tmpDir)
	if err != nil || len(applied) != 1 {
		t.Fatalf("apply up failed: %v (applied=%v)", err, applied)
	}

	_ = os.WriteFile(filePath, []byte("-- +nexus Up\nSELECT 1;\n"), 0644)
	_, err = mig.ApplyUp(ctx, tmpDir)
	if err == nil {
		t.Fatalf("expected checksum conflict error when migration file is modified after apply")
	}
}
