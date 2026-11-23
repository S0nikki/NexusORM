package query

import (
	"strings"
	"testing"

	"nexus/engine/internal/protocol"
	"nexus/engine/internal/registry"
)

func setupUserModel(t *testing.T) *registry.RegisteredModel {
	reg := registry.NewRegistry()
	err := reg.RegisterManifest(protocol.SchemaManifest{
		Models: []protocol.ModelSchema{
			{
				Name: "User",
				Fields: []protocol.FieldSchema{
					{Name: "id", Type: "uuid", PrimaryKey: true},
					{Name: "username", Type: "string"},
					{Name: "active", Type: "boolean"},
					{Name: "age", Type: "integer"},
				},
			},
		},
	})
	if err != nil {
		t.Fatalf("register error: %v", err)
	}
	m, _ := reg.Get("User")
	return m
}

func TestCompileFilterAndParameterization(t *testing.T) {
	model := setupUserModel(t)
	ast := &protocol.FilterNode{
		AND: []protocol.FilterNode{
			{Field: "active", Op: "eq", Value: true},
			{
				OR: []protocol.FilterNode{
					{Field: "age", Op: "gte", Value: 18},
					{Field: "username", Op: "contains", Value: "admin'; DROP TABLE users;--"},
				},
			},
		},
	}

	sqlStr, args, err := CompileFilter(model, ast)
	if err != nil {
		t.Fatalf("unexpected compile error: %v", err)
	}
	if strings.Contains(sqlStr, "DROP TABLE") {
		t.Fatalf("SQL injection payload leaked into raw SQL clause: %s", sqlStr)
	}
	if len(args) != 3 {
		t.Fatalf("expected 3 parameterized bind values, got %d", len(args))
	}
}

func TestRejectUnknownFieldInFilter(t *testing.T) {
	model := setupUserModel(t)
	badFilter := &protocol.FilterNode{
		Field: "nonExistent; DROP TABLE users",
		Op:    "eq",
		Value: "x",
	}
	_, _, err := CompileFilter(model, badFilter)
	if err == nil {
		t.Fatalf("expected error for non-whitelisted column name")
	}
}
