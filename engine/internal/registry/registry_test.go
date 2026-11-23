package registry

import (
	"testing"

	"nexus/engine/internal/protocol"
)

func TestRegisterManifestAndValidation(t *testing.T) {
	reg := NewRegistry()
	manifest := protocol.SchemaManifest{
		Models: []protocol.ModelSchema{
			{
				Name: "User",
				Fields: []protocol.FieldSchema{
					{Name: "id", Type: "uuid", PrimaryKey: true},
					{Name: "username", Type: "string", Unique: true},
					{Name: "createdAt", Type: "date"},
				},
			},
		},
	}

	if err := reg.RegisterManifest(manifest); err != nil {
		t.Fatalf("expected valid manifest to register, got: %v", err)
	}

	m, ok := reg.Get("User")
	if !ok {
		t.Fatalf("expected User model to be found")
	}
	if m.Schema.TableName != "users" {
		t.Fatalf("expected default snake_case plural table name 'users', got %s", m.Schema.TableName)
	}
	if m.ColsByField["createdAt"] != "created_at" {
		t.Fatalf("expected createdAt column to be 'created_at', got %s", m.ColsByField["createdAt"])
	}
	if m.StructType.NumField() != 3 {
		t.Fatalf("expected dynamic reflect.StructOf to have 3 fields, got %d", m.StructType.NumField())
	}

	// Reject SQL injection in identifiers
	badManifest := protocol.SchemaManifest{
		Models: []protocol.ModelSchema{
			{
				Name: "User; DROP TABLE users;--",
				Fields: []protocol.FieldSchema{
					{Name: "id", Type: "string"},
				},
			},
		},
	}
	if err := reg.RegisterManifest(badManifest); err == nil {
		t.Fatalf("expected unsafe identifier to be rejected")
	}
}
