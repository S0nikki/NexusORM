#!/usr/bin/env node
// write-nexus-all.mjs
// Generates all Project Nexus files across Phases 2 through 10.
// Run with: node write-nexus-all.mjs

import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();

const files = {
  // ============================================================================
  // WORKSPACE ROOT & CONFIGS
  // ============================================================================
  "package.json": JSON.stringify(
    {
      name: "nexus-orm-workspace",
      version: "0.1.0",
      private: true,
      type: "module",
      workspaces: ["packages/*"],
      scripts: {
        "build:go":
          "cd engine && go build -o ../packages/core/bin/nexus-engine ./cmd/nexus-engine",
        "build:ts": "npm run build --workspaces",
        build: "npm run build:go && npm run build:ts",
        "test:go": "cd engine && go test -v ./...",
        "test:ts": "npx vitest run",
        test: "npm run test:go && npm run test:ts",
      },
      devDependencies: {
        "@types/node": "^22.0.0",
        typescript: "^5.6.0",
        vitest: "^2.1.0",
      },
      engines: {
        node: ">=20.0.0",
      },
    },
    null,
    2
  ),

  "tsconfig.base.json": JSON.stringify(
    {
      compilerOptions: {
        target: "ES2022",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        lib: ["ES2022"],
        strict: true,
        noUncheckedIndexedAccess: true,
        noImplicitOverride: true,
        noFallthroughCasesInSwitch: true,
        forceConsistentCasingInFileNames: true,
        declaration: true,
        declarationMap: true,
        sourceMap: true,
        esModuleInterop: true,
        skipLibCheck: true,
      },
    },
    null,
    2
  ),

  "engine/go.mod": [
    "module nexus/engine",
    "",
    "go 1.22",
    "",
    "require (",
    "\tgithub.com/google/uuid v1.6.0",
    "\tgorm.io/driver/mysql v1.5.7",
    "\tgorm.io/driver/postgres v1.5.9",
    "\tgorm.io/driver/sqlite v1.5.6",
    "\tgorm.io/gorm v1.25.12",
    ")",
    "",
  ].join("\n"),

  // ============================================================================
  // PHASE 2: FOUNDATION — GO PROTOCOL & CREDENTIAL SCRUBBING
  // ============================================================================
  "engine/internal/protocol/protocol.go": `package protocol

import (
	"encoding/json"
	"regexp"
)

const (
	ProtocolVersion = 1
	EngineVersion   = "0.1.0"
)

const (
	ErrVersionMismatch     = "NEXUS_VERSION_MISMATCH"
	ErrConfigInvalid       = "NEXUS_CONFIG_INVALID"
	ErrConnectionFailed    = "NEXUS_CONNECTION_FAILED"
	ErrUniqueViolation     = "NEXUS_UNIQUE_VIOLATION"
	ErrForeignKeyViolation = "NEXUS_FOREIGN_KEY_VIOLATION"
	ErrNotFound            = "NEXUS_NOT_FOUND"
	ErrTimeout             = "NEXUS_TIMEOUT"
	ErrTxExpired           = "NEXUS_TX_EXPIRED"
	ErrMigrationConflict   = "NEXUS_MIGRATION_CONFLICT"
	ErrValidation          = "NEXUS_VALIDATION_ERROR"
	ErrInternal            = "NEXUS_INTERNAL_ERROR"
)

type Request struct {
	Version   int             \`json:"v"\`
	ID        string          \`json:"id"\`
	Method    string          \`json:"method"\`
	TimeoutMs int             \`json:"timeoutMs,omitempty"\`
	Params    json.RawMessage \`json:"params,omitempty"\`
}

type Response struct {
	Version int          \`json:"v"\`
	ID      string       \`json:"id"\`
	OK      bool         \`json:"ok"\`
	Result  any          \`json:"result,omitempty"\`
	Error   *ErrorDetail \`json:"error,omitempty"\`
}

type ErrorDetail struct {
	Code      string   \`json:"code"\`
	Message   string   \`json:"message"\`
	Model     string   \`json:"model,omitempty"\`
	Fields    []string \`json:"fields,omitempty"\`
	Retryable bool     \`json:"retryable"\`
}

type HandshakeRequest struct {
	ClientVersion   string \`json:"clientVersion"\`
	ProtocolVersion int    \`json:"protocolVersion"\`
}

type HandshakeResponse struct {
	EngineVersion   string \`json:"engineVersion"\`
	ProtocolVersion int    \`json:"protocolVersion"\`
}

type PoolConfig struct {
	Min           int \`json:"min"\`
	Max           int \`json:"max"\`
	IdleTimeoutMs int \`json:"idleTimeoutMs,omitempty"\`
}

type ConnectionConfig struct {
	Dialect  string     \`json:"dialect"\`
	URL      string     \`json:"url"\`
	Pool     PoolConfig \`json:"pool"\`
	LogLevel string     \`json:"logLevel"\`
}

type ReferenceSchema struct {
	Model    string \`json:"model"\`
	Column   string \`json:"column"\`
	OnDelete string \`json:"onDelete,omitempty"\`
}

type FieldSchema struct {
	Name          string           \`json:"name"\`
	Column        string           \`json:"column"\`
	Type          string           \`json:"type"\`
	PrimaryKey    bool             \`json:"primaryKey"\`
	Unique        bool             \`json:"unique"\`
	Nullable      bool             \`json:"nullable"\`
	Index         bool             \`json:"index"\`
	AutoIncrement bool             \`json:"autoIncrement"\`
	MaxLength     int              \`json:"maxLength,omitempty"\`
	DefaultKind   string           \`json:"defaultKind,omitempty"\` // "none" | "static" | "now" | "uuid"
	DefaultValue  any              \`json:"defaultValue,omitempty"\`
	References    *ReferenceSchema \`json:"references,omitempty"\`
}

type RelationSchema struct {
	Name       string \`json:"name"\`
	Kind       string \`json:"kind"\` // "oneToOne" | "oneToMany" | "manyToOne" | "manyToMany"
	Target     string \`json:"target"\`
	ForeignKey string \`json:"foreignKey"\`
	References string \`json:"references"\`
	JoinTable  string \`json:"joinTable,omitempty"\`
}

type ModelSchema struct {
	Name      string           \`json:"name"\`
	TableName string           \`json:"tableName"\`
	Fields    []FieldSchema    \`json:"fields"\`
	Relations []RelationSchema \`json:"relations,omitempty"\`
}

type SchemaManifest struct {
	Models []ModelSchema \`json:"models"\`
}

type FilterNode struct {
	Field string       \`json:"field,omitempty"\`
	Op    string       \`json:"op,omitempty"\`
	Value any          \`json:"value,omitempty"\`
	AND   []FilterNode \`json:"AND,omitempty"\`
	OR    []FilterNode \`json:"OR,omitempty"\`
	NOT   *FilterNode  \`json:"NOT,omitempty"\`
}

type OrderByNode struct {
	Field string \`json:"field"\`
	Dir   string \`json:"dir"\` // "asc" | "desc"
}

type IncludeNode struct {
	Where   *FilterNode            \`json:"where,omitempty"\`
	Select  []string               \`json:"select,omitempty"\`
	OrderBy []OrderByNode          \`json:"orderBy,omitempty"\`
	Limit   int                    \`json:"limit,omitempty"\`
	Offset  int                    \`json:"offset,omitempty"\`
	Include map[string]IncludeNode \`json:"include,omitempty"\`
}

type QueryAST struct {
	TxID      string                 \`json:"txId,omitempty"\`
	Model     string                 \`json:"model"\`
	Operation string                 \`json:"operation"\`
	Where     *FilterNode            \`json:"where,omitempty"\`
	Data      map[string]any         \`json:"data,omitempty"\`
	DataList  []map[string]any       \`json:"dataList,omitempty"\`
	Select    []string               \`json:"select,omitempty"\`
	Include   map[string]IncludeNode \`json:"include,omitempty"\`
	OrderBy   []OrderByNode          \`json:"orderBy,omitempty"\`
	Limit     int                    \`json:"limit,omitempty"\`
	Offset    int                    \`json:"offset,omitempty"\`
}

type QueryResult struct {
	Rows         []map[string]any \`json:"rows"\`
	Row          map[string]any   \`json:"row,omitempty"\`
	AffectedRows int64            \`json:"affectedRows"\`
	Count        int64            \`json:"count"\`
	Exists       bool             \`json:"exists"\`
}

type TxOptions struct {
	TimeoutMs int \`json:"timeoutMs,omitempty"\`
}

var (
	urlCredRegex = regexp.MustCompile(\`([a-zA-Z0-9+.-]+://[^:/\\s]+:)([^@\\s]+)(@)\`)
	kvPassRegex  = regexp.MustCompile(\`(?i)(password|passwd|pwd|secret)=([^\\s&;]+)\`)
)

// ScrubCredentials redacts database passwords from error messages and logs.
func ScrubCredentials(input string) string {
	masked := urlCredRegex.ReplaceAllString(input, "${1}[REDACTED]${3}")
	masked = kvPassRegex.ReplaceAllString(masked, "${1}=[REDACTED]")
	return masked
}

func NewSuccessResponse(id string, result any) Response {
	return Response{
		Version: ProtocolVersion,
		ID:      id,
		OK:      true,
		Result:  result,
	}
}

func NewErrorResponse(id, code, message, model string, fields []string, retryable bool) Response {
	return Response{
		Version: ProtocolVersion,
		ID:      id,
		OK:      false,
		Error: &ErrorDetail{
			Code:      code,
			Message:   ScrubCredentials(message),
			Model:     model,
			Fields:    fields,
			Retryable: retryable,
		},
	}
}
`,

  "engine/internal/protocol/protocol_test.go": `package protocol

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestScrubCredentials(t *testing.T) {
	rawURL := "Failed connecting to postgres://admin:superSecret123@db.internal:5432/nexus"
	scrubbed := ScrubCredentials(rawURL)
	if strings.Contains(scrubbed, "superSecret123") {
		t.Fatalf("expected password to be scrubbed, got: %s", scrubbed)
	}
	if !strings.Contains(scrubbed, "postgres://admin:[REDACTED]@db.internal:5432/nexus") {
		t.Fatalf("unexpected scrubbed output: %s", scrubbed)
	}

	dsn := "host=localhost user=root password=my_secret_pw dbname=app"
	scrubbedDSN := ScrubCredentials(dsn)
	if strings.Contains(scrubbedDSN, "my_secret_pw") {
		t.Fatalf("expected key-value password to be scrubbed, got: %s", scrubbedDSN)
	}
}

func TestEnvelopeSerialization(t *testing.T) {
	resp := NewErrorResponse("req_1", ErrUniqueViolation, "duplicate key for postgres://u:p@localhost/db", "User", []string{"email"}, false)
	data, err := json.Marshal(resp)
	if err != nil {
		t.Fatalf("marshal error: %v", err)
	}
	var decoded Response
	if err := json.Unmarshal(data, &decoded); err != nil {
		t.Fatalf("unmarshal error: %v", err)
	}
	if decoded.OK || decoded.Error == nil {
		t.Fatalf("expected error response")
	}
	if decoded.Error.Code != ErrUniqueViolation {
		t.Fatalf("expected code %s, got %s", ErrUniqueViolation, decoded.Error.Code)
	}
	if strings.Contains(decoded.Error.Message, ":p@") {
		t.Fatalf("credentials leaked in error envelope: %s", decoded.Error.Message)
	}
}
`,

  // ============================================================================
  // PHASE 3: GO BACKEND DRIVER INTERFACE & TRANSACTION MANAGER
  // ============================================================================
  "engine/internal/backend/driver.go": `package backend

import (
	"context"
	"nexus/engine/internal/protocol"
)

type Driver interface {
	Connect(ctx context.Context, cfg protocol.ConnectionConfig) error
	RegisterSchema(ctx context.Context, manifest protocol.SchemaManifest) error
	PushSchema(ctx context.Context) error
	ExecuteQuery(ctx context.Context, ast protocol.QueryAST) (protocol.QueryResult, error)
	ExecRawSQL(ctx context.Context, sqlStr string, args ...any) error
	BeginTx(ctx context.Context, opts protocol.TxOptions) (string, error)
	CommitTx(ctx context.Context, txID string) error
	RollbackTx(ctx context.Context, txID string) error
	Dialect() string
	Ping(ctx context.Context) error
	Close() error
}
`,

  "engine/internal/tx/manager.go": `package tx

import (
	"context"
	"fmt"
	"sync"
	"time"

	"github.com/google/uuid"
	"gorm.io/gorm"
)

type entry struct {
	db        *gorm.DB
	expiresAt time.Time
}

type Manager struct {
	mu       sync.RWMutex
	sessions map[string]*entry
	stopCh   chan struct{}
}

func NewManager() *Manager {
	m := &Manager{
		sessions: make(map[string]*entry),
		stopCh:   make(chan struct{}),
	}
	go m.watchdog()
	return m
}

func (m *Manager) Begin(ctx context.Context, rootDB *gorm.DB, timeoutMs int) (string, error) {
	if timeoutMs <= 0 {
		timeoutMs = 15000
	}
	txDB := rootDB.WithContext(ctx).Begin()
	if txDB.Error != nil {
		return "", txDB.Error
	}
	id := "tx_" + uuid.NewString()
	m.mu.Lock()
	m.sessions[id] = &entry{
		db:        txDB,
		expiresAt: time.Now().Add(time.Duration(timeoutMs) * time.Millisecond),
	}
	m.mu.Unlock()
	return id, nil
}

func (m *Manager) Get(txID string) (*gorm.DB, error) {
	m.mu.RLock()
	e, ok := m.sessions[txID]
	m.mu.RUnlock()
	if !ok {
		return nil, fmt.Errorf("transaction %s not found or expired", txID)
	}
	if time.Now().After(e.expiresAt) {
		_ = m.Rollback(txID)
		return nil, fmt.Errorf("transaction %s timed out", txID)
	}
	return e.db, nil
}

func (m *Manager) Commit(txID string) error {
	m.mu.Lock()
	e, ok := m.sessions[txID]
	if ok {
		delete(m.sessions, txID)
	}
	m.mu.Unlock()
	if !ok {
		return fmt.Errorf("transaction %s not found or already closed", txID)
	}
	return e.db.Commit().Error
}

func (m *Manager) Rollback(txID string) error {
	m.mu.Lock()
	e, ok := m.sessions[txID]
	if ok {
		delete(m.sessions, txID)
	}
	m.mu.Unlock()
	if !ok {
		return fmt.Errorf("transaction %s not found or already closed", txID)
	}
	return e.db.Rollback().Error
}

func (m *Manager) watchdog() {
	ticker := time.NewTicker(1 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-m.stopCh:
			return
		case now := <-ticker.C:
			m.mu.Lock()
			for id, e := range m.sessions {
				if now.After(e.expiresAt) {
					_ = e.db.Rollback()
					delete(m.sessions, id)
				}
			}
			m.mu.Unlock()
		}
	}
}

func (m *Manager) CloseAll() {
	close(m.stopCh)
	m.mu.Lock()
	defer m.mu.Unlock()
	for id, e := range m.sessions {
		_ = e.db.Rollback()
		delete(m.sessions, id)
	}
}
`,

  // ============================================================================
  // PHASE 4: GO DYNAMIC MODEL REGISTRY (reflect.StructOf + Identifier Safety)
  // ============================================================================
  "engine/internal/registry/registry.go": `package registry

import (
	"fmt"
	"reflect"
	"regexp"
	"strings"
	"sync"
	"time"

	"nexus/engine/internal/protocol"
)

var validIdentifier = regexp.MustCompile(\`^[a-zA-Z_][a-zA-Z0-9_]*$\`)

type RegisteredModel struct {
	Schema       protocol.ModelSchema
	StructType   reflect.Type
	FieldsByName map[string]protocol.FieldSchema
	ColsByField  map[string]string
	FieldsByCol  map[string]protocol.FieldSchema
	Relations    map[string]protocol.RelationSchema
	PrimaryKey   protocol.FieldSchema
}

type Registry struct {
	mu     sync.RWMutex
	models map[string]*RegisteredModel
}

func NewRegistry() *Registry {
	return &Registry{
		models: make(map[string]*RegisteredModel),
	}
}

func ValidateIdentifier(ident string) error {
	if !validIdentifier.MatchString(ident) {
		return fmt.Errorf("unsafe or invalid identifier %q", ident)
	}
	return nil
}

func ToSnakeCase(str string) string {
	var out strings.Builder
	for i, r := range str {
		if r >= 'A' && r <= 'Z' {
			if i > 0 {
				out.WriteByte('_')
			}
			out.WriteRune(r + ('a' - 'A'))
		} else {
			out.WriteRune(r)
		}
	}
	return out.String()
}

func (r *Registry) RegisterManifest(manifest protocol.SchemaManifest) error {
	r.mu.Lock()
	defer r.mu.Unlock()

	next := make(map[string]*RegisteredModel, len(manifest.Models))
	for _, m := range manifest.Models {
		if err := ValidateIdentifier(m.Name); err != nil {
			return err
		}
		tableName := m.TableName
		if tableName == "" {
			tableName = ToSnakeCase(m.Name) + "s"
		}
		if err := ValidateIdentifier(tableName); err != nil {
			return err
		}
		m.TableName = tableName

		fieldsByName := make(map[string]protocol.FieldSchema, len(m.Fields))
		colsByField := make(map[string]string, len(m.Fields))
		fieldsByCol := make(map[string]protocol.FieldSchema, len(m.Fields))
		structFields := make([]reflect.StructField, 0, len(m.Fields))
		var pkField protocol.FieldSchema

		for i, f := range m.Fields {
			if err := ValidateIdentifier(f.Name); err != nil {
				return err
			}
			col := f.Column
			if col == "" {
				col = ToSnakeCase(f.Name)
			}
			if err := ValidateIdentifier(col); err != nil {
				return err
			}
			f.Column = col
			m.Fields[i] = f
			fieldsByName[f.Name] = f
			colsByField[f.Name] = col
			fieldsByCol[col] = f
			if f.PrimaryKey {
				pkField = f
			}

			goType := resolveGoType(f)
			gormTag := buildGormTag(f)
			structFields = append(structFields, reflect.StructField{
				Name: "F_" + f.Name,
				Type: goType,
				Tag:  reflect.StructTag(fmt.Sprintf(\`gorm:"%s" json:"%s"\`, gormTag, f.Name)),
			})
		}

		relationsMap := make(map[string]protocol.RelationSchema, len(m.Relations))
		for _, rel := range m.Relations {
			if err := ValidateIdentifier(rel.Name); err != nil {
				return err
			}
			relationsMap[rel.Name] = rel
		}

		next[m.Name] = &RegisteredModel{
			Schema:       m,
			StructType:   reflect.StructOf(structFields),
			FieldsByName: fieldsByName,
			ColsByField:  colsByField,
			FieldsByCol:  fieldsByCol,
			Relations:    relationsMap,
			PrimaryKey:   pkField,
		}
	}

	r.models = next
	return nil
}

func (r *Registry) Get(modelName string) (*RegisteredModel, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	m, ok := r.models[modelName]
	return m, ok
}

func (r *Registry) All() []*RegisteredModel {
	r.mu.RLock()
	defer r.mu.RUnlock()
	list := make([]*RegisteredModel, 0, len(r.models))
	for _, m := range r.models {
		list = append(list, m)
	}
	return list
}

func resolveGoType(f protocol.FieldSchema) reflect.Type {
	var base reflect.Type
	switch f.Type {
	case "string", "uuid", "json":
		base = reflect.TypeOf("")
	case "integer":
		base = reflect.TypeOf(int64(0))
	case "float":
		base = reflect.TypeOf(float64(0))
	case "boolean":
		base = reflect.TypeOf(false)
	case "date", "timestamp":
		base = reflect.TypeOf(time.Time{})
	default:
		base = reflect.TypeOf("")
	}
	if f.Nullable {
		return reflect.PointerTo(base)
	}
	return base
}

func buildGormTag(f protocol.FieldSchema) string {
	parts := []string{"column:" + f.Column}
	if f.PrimaryKey {
		parts = append(parts, "primaryKey")
	}
	if f.AutoIncrement {
		parts = append(parts, "autoIncrement")
	}
	if f.Unique {
		parts = append(parts, "uniqueIndex")
	} else if f.Index {
		parts = append(parts, "index")
	}
	if !f.Nullable && !f.PrimaryKey {
		parts = append(parts, "not null")
	}
	if f.MaxLength > 0 && f.Type == "string" {
		parts = append(parts, fmt.Sprintf("size:%d", f.MaxLength))
	}
	return strings.Join(parts, ";")
}
`,

  "engine/internal/registry/registry_test.go": `package registry

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
`,

  // ============================================================================
  // PHASE 5: GO PARAMETERIZED QUERY COMPILER
  // ============================================================================
  "engine/internal/query/compiler.go": `package query

import (
	"fmt"
	"strings"

	"nexus/engine/internal/protocol"
	"nexus/engine/internal/registry"
)

// CompileFilter recursively compiles a FilterNode into a parameterized SQL expression and slice of bind values.
// All column names are strictly resolved against the RegisteredModel whitelist.
func CompileFilter(model *registry.RegisteredModel, node *protocol.FilterNode) (string, []any, error) {
	if node == nil {
		return "", nil, nil
	}

	var clauses []string
	var args []any

	if len(node.AND) > 0 {
		var subClauses []string
		for i := range node.AND {
			sqlStr, subArgs, err := CompileFilter(model, &node.AND[i])
			if err != nil {
				return "", nil, err
			}
			if sqlStr != "" {
				subClauses = append(subClauses, sqlStr)
				args = append(args, subArgs...)
			}
		}
		if len(subClauses) > 0 {
			clauses = append(clauses, "("+strings.Join(subClauses, " AND ")+")")
		}
	}

	if len(node.OR) > 0 {
		var subClauses []string
		for i := range node.OR {
			sqlStr, subArgs, err := CompileFilter(model, &node.OR[i])
			if err != nil {
				return "", nil, err
			}
			if sqlStr != "" {
				subClauses = append(subClauses, sqlStr)
				args = append(args, subArgs...)
			}
		}
		if len(subClauses) > 0 {
			clauses = append(clauses, "("+strings.Join(subClauses, " OR ")+")")
		}
	}

	if node.NOT != nil {
		sqlStr, subArgs, err := CompileFilter(model, node.NOT)
		if err != nil {
			return "", nil, err
		}
		if sqlStr != "" {
			clauses = append(clauses, "(NOT "+sqlStr+")")
			args = append(args, subArgs...)
		}
	}

	if node.Field != "" {
		col, ok := model.ColsByField[node.Field]
		if !ok {
			return "", nil, fmt.Errorf("unknown field %q on model %q", node.Field, model.Schema.Name)
		}
		quotedCol := \`"\` + col + \`"\`
		op := node.Op
		if op == "" {
			op = "eq"
		}

		switch op {
		case "eq":
			if node.Value == nil {
				clauses = append(clauses, quotedCol+" IS NULL")
			} else {
				clauses = append(clauses, quotedCol+" = ?")
				args = append(args, node.Value)
			}
		case "neq":
			if node.Value == nil {
				clauses = append(clauses, quotedCol+" IS NOT NULL")
			} else {
				clauses = append(clauses, quotedCol+" <> ?")
				args = append(args, node.Value)
			}
		case "gt":
			clauses = append(clauses, quotedCol+" > ?")
			args = append(args, node.Value)
		case "gte":
			clauses = append(clauses, quotedCol+" >= ?")
			args = append(args, node.Value)
		case "lt":
			clauses = append(clauses, quotedCol+" < ?")
			args = append(args, node.Value)
		case "lte":
			clauses = append(clauses, quotedCol+" <= ?")
			args = append(args, node.Value)
		case "in":
			slice := toAnySlice(node.Value)
			if len(slice) == 0 {
				clauses = append(clauses, "1 = 0")
			} else {
				clauses = append(clauses, quotedCol+" IN ?")
				args = append(args, slice)
			}
		case "notIn":
			slice := toAnySlice(node.Value)
			if len(slice) == 0 {
				clauses = append(clauses, "1 = 1")
			} else {
				clauses = append(clauses, quotedCol+" NOT IN ?")
				args = append(args, slice)
			}
		case "contains":
			clauses = append(clauses, quotedCol+" LIKE ?")
			args = append(args, fmt.Sprintf("%%%v%%", node.Value))
		case "startsWith":
			clauses = append(clauses, quotedCol+" LIKE ?")
			args = append(args, fmt.Sprintf("%v%%", node.Value))
		case "endsWith":
			clauses = append(clauses, quotedCol+" LIKE ?")
			args = append(args, fmt.Sprintf("%%%v", node.Value))
		case "isNull":
			isNullBool, _ := node.Value.(bool)
			if isNullBool {
				clauses = append(clauses, quotedCol+" IS NULL")
			} else {
				clauses = append(clauses, quotedCol+" IS NOT NULL")
			}
		default:
			return "", nil, fmt.Errorf("unsupported filter operator %q", op)
		}
	}

	return strings.Join(clauses, " AND "), args, nil
}

func CompileSelect(model *registry.RegisteredModel, selectFields []string) ([]string, error) {
	if len(selectFields) == 0 {
		cols := make([]string, 0, len(model.Schema.Fields))
		for _, f := range model.Schema.Fields {
			cols = append(cols, \`"\`+f.Column+\`"\`)
		}
		return cols, nil
	}
	cols := make([]string, 0, len(selectFields))
	for _, fieldName := range selectFields {
		col, ok := model.ColsByField[fieldName]
		if !ok {
			return nil, fmt.Errorf("unknown select field %q on model %q", fieldName, model.Schema.Name)
		}
		cols = append(cols, \`"\`+col+\`"\`)
	}
	return cols, nil
}

func CompileOrderBy(model *registry.RegisteredModel, orders []protocol.OrderByNode) (string, error) {
	if len(orders) == 0 {
		return "", nil
	}
	parts := make([]string, 0, len(orders))
	for _, o := range orders {
		col, ok := model.ColsByField[o.Field]
		if !ok {
			return "", fmt.Errorf("unknown orderBy field %q on model %q", o.Field, model.Schema.Name)
		}
		dir := strings.ToUpper(o.Dir)
		if dir != "ASC" && dir != "DESC" {
			return "", fmt.Errorf("invalid sort direction %q", o.Dir)
		}
		parts = append(parts, \`"\`+col+\`" \`+dir)
	}
	return strings.Join(parts, ", "), nil
}

func toAnySlice(val any) []any {
	if val == nil {
		return nil
	}
	if s, ok := val.([]any); ok {
		return s
	}
	return []any{val}
}
`,

  "engine/internal/query/compiler_test.go": `package query

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
`,

  // ============================================================================
  // PHASE 6: GO GORM DRIVER (CRUD + EAGER LOADING + TRANSACTIONS + DIALECTS)
  // ============================================================================
  "engine/internal/backend/gormdrv/driver.go": `package gormdrv

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"gorm.io/driver/mysql"
	"gorm.io/driver/postgres"
	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"

	"nexus/engine/internal/protocol"
	"nexus/engine/internal/query"
	"nexus/engine/internal/registry"
	"nexus/engine/internal/tx"
)

type GormDriver struct {
	db       *gorm.DB
	dialect  string
	registry *registry.Registry
	txMgr    *tx.Manager
}

func NewGormDriver(reg *registry.Registry) *GormDriver {
	return &GormDriver{
		registry: reg,
		txMgr:    tx.NewManager(),
	}
}

func (d *GormDriver) Dialect() string {
	return d.dialect
}

func (d *GormDriver) DB() *gorm.DB {
	return d.db
}

func (d *GormDriver) Registry() *registry.Registry {
	return d.registry
}

func (d *GormDriver) Connect(ctx context.Context, cfg protocol.ConnectionConfig) error {
	var dialector gorm.Dialector
	switch cfg.Dialect {
	case "postgres":
		dialector = postgres.Open(cfg.URL)
	case "mysql":
		dialector = mysql.Open(cfg.URL)
	case "sqlite":
		dsn := strings.TrimPrefix(cfg.URL, "file:")
		if dsn == "" {
			dsn = ":memory:"
		}
		dialector = sqlite.Open(dsn)
	default:
		return fmt.Errorf("unsupported database dialect %q", cfg.Dialect)
	}

	gormCfg := &gorm.Config{
		Logger: logger.Default.LogMode(logger.Silent),
	}

	db, err := gorm.Open(dialector, gormCfg)
	if err != nil {
		return err
	}

	sqlDB, err := db.DB()
	if err != nil {
		return err
	}
	if cfg.Pool.Min > 0 {
		sqlDB.SetMaxIdleConns(cfg.Pool.Min)
	}
	if cfg.Pool.Max > 0 {
		sqlDB.SetMaxOpenConns(cfg.Pool.Max)
	}
	if cfg.Pool.IdleTimeoutMs > 0 {
		sqlDB.SetConnMaxIdleTime(time.Duration(cfg.Pool.IdleTimeoutMs) * time.Millisecond)
	}

	if cfg.Dialect == "sqlite" {
		db.Exec("PRAGMA foreign_keys = ON;")
	}

	d.db = db
	d.dialect = cfg.Dialect
	return nil
}

func (d *GormDriver) RegisterSchema(ctx context.Context, manifest protocol.SchemaManifest) error {
	return d.registry.RegisterManifest(manifest)
}

func (d *GormDriver) PushSchema(ctx context.Context) error {
	if d.db == nil {
		return fmt.Errorf("database not connected")
	}
	for _, m := range d.registry.All() {
		ddl := BuildCreateTableSQL(d.dialect, m.Schema)
		if err := d.db.WithContext(ctx).Exec(ddl).Error; err != nil {
			return err
		}
		for _, idxSQL := range BuildIndexSQL(m.Schema) {
			if err := d.db.WithContext(ctx).Exec(idxSQL).Error; err != nil {
				return err
			}
		}
		for _, rel := range m.Schema.Relations {
			if rel.Kind == "manyToMany" && rel.JoinTable != "" {
				targetModel, ok := d.registry.Get(rel.Target)
				if !ok {
					continue
				}
				jtSQL := BuildJoinTableSQL(rel.JoinTable, m.Schema, targetModel.Schema)
				if err := d.db.WithContext(ctx).Exec(jtSQL).Error; err != nil {
					return err
				}
			}
		}
	}
	return nil
}

func (d *GormDriver) ExecRawSQL(ctx context.Context, sqlStr string, args ...any) error {
	return d.db.WithContext(ctx).Exec(sqlStr, args...).Error
}

func (d *GormDriver) BeginTx(ctx context.Context, opts protocol.TxOptions) (string, error) {
	return d.txMgr.Begin(ctx, d.db, opts.TimeoutMs)
}

func (d *GormDriver) CommitTx(ctx context.Context, txID string) error {
	return d.txMgr.Commit(txID)
}

func (d *GormDriver) RollbackTx(ctx context.Context, txID string) error {
	return d.txMgr.Rollback(txID)
}

func (d *GormDriver) Ping(ctx context.Context) error {
	if d.db == nil {
		return fmt.Errorf("database not initialized")
	}
	sqlDB, err := d.db.DB()
	if err != nil {
		return err
	}
	return sqlDB.PingContext(ctx)
}

func (d *GormDriver) Close() error {
	d.txMgr.CloseAll()
	if d.db == nil {
		return nil
	}
	sqlDB, err := d.db.DB()
	if err != nil {
		return err
	}
	return sqlDB.Close()
}

func (d *GormDriver) resolveSession(ctx context.Context, txID string) (*gorm.DB, error) {
	if txID == "" {
		return d.db.WithContext(ctx), nil
	}
	txDB, err := d.txMgr.Get(txID)
	if err != nil {
		return nil, err
	}
	return txDB.WithContext(ctx), nil
}

func (d *GormDriver) ExecuteQuery(ctx context.Context, ast protocol.QueryAST) (protocol.QueryResult, error) {
	model, ok := d.registry.Get(ast.Model)
	if !ok {
		return protocol.QueryResult{}, fmt.Errorf("model %q is not registered", ast.Model)
	}

	session, err := d.resolveSession(ctx, ast.TxID)
	if err != nil {
		return protocol.QueryResult{}, err
	}

	switch ast.Operation {
	case "findMany":
		rows, err := d.execFindMany(ctx, session, model, ast)
		return protocol.QueryResult{Rows: rows}, err

	case "findFirst", "findUnique":
		ast.Limit = 1
		rows, err := d.execFindMany(ctx, session, model, ast)
		if err != nil {
			return protocol.QueryResult{}, err
		}
		if len(rows) == 0 {
			return protocol.QueryResult{Rows: []map[string]any{}, Row: nil}, nil
		}
		return protocol.QueryResult{Rows: rows, Row: rows[0]}, nil

	case "create":
		row, err := d.execCreate(ctx, session, model, ast)
		if err != nil {
			return protocol.QueryResult{}, err
		}
		return protocol.QueryResult{Row: row, Rows: []map[string]any{row}, AffectedRows: 1}, nil

	case "createMany":
		count, err := d.execCreateMany(ctx, session, model, ast)
		return protocol.QueryResult{AffectedRows: count, Count: count}, err

	case "update":
		row, err := d.execUpdate(ctx, session, model, ast)
		if err != nil {
			return protocol.QueryResult{}, err
		}
		return protocol.QueryResult{Row: row, AffectedRows: 1}, nil

	case "updateMany":
		affected, err := d.execUpdateMany(ctx, session, model, ast)
		return protocol.QueryResult{AffectedRows: affected, Count: affected}, err

	case "delete":
		row, err := d.execDeleteOne(ctx, session, model, ast)
		if err != nil {
			return protocol.QueryResult{}, err
		}
		return protocol.QueryResult{Row: row, AffectedRows: 1}, nil

	case "deleteMany":
		affected, err := d.execDeleteMany(ctx, session, model, ast)
		return protocol.QueryResult{AffectedRows: affected, Count: affected}, err

	case "count":
		count, err := d.execCount(session, model, ast)
		return protocol.QueryResult{Count: count}, err

	case "exists":
		count, err := d.execCount(session, model, ast)
		return protocol.QueryResult{Exists: count > 0, Count: count}, err

	default:
		return protocol.QueryResult{}, fmt.Errorf("unsupported query operation %q", ast.Operation)
	}
}

func (d *GormDriver) execFindMany(ctx context.Context, session *gorm.DB, model *registry.RegisteredModel, ast protocol.QueryAST) ([]map[string]any, error) {
	tx := session.Table(model.Schema.TableName)

	// Ensure primary key and foreign keys are fetched when relations are included
	selectToUse := ast.Select
	if len(selectToUse) > 0 && len(ast.Include) > 0 {
		hasPK := false
		for _, s := range selectToUse {
			if s == model.PrimaryKey.Name {
				hasPK = true
				break
			}
		}
		if !hasPK && model.PrimaryKey.Name != "" {
			selectToUse = append(selectToUse, model.PrimaryKey.Name)
		}
	}

	cols, err := query.CompileSelect(model, selectToUse)
	if err != nil {
		return nil, err
	}
	tx = tx.Select(cols)

	whereSQL, whereArgs, err := query.CompileFilter(model, ast.Where)
	if err != nil {
		return nil, err
	}
	if whereSQL != "" {
		tx = tx.Where(whereSQL, whereArgs...)
	}

	orderSQL, err := query.CompileOrderBy(model, ast.OrderBy)
	if err != nil {
		return nil, err
	}
	if orderSQL != "" {
		tx = tx.Order(orderSQL)
	}

	if ast.Limit > 0 {
		tx = tx.Limit(ast.Limit)
	}
	if ast.Offset > 0 {
		tx = tx.Offset(ast.Offset)
	}

	var rawRows []map[string]any
	if err := tx.Find(&rawRows).Error; err != nil {
		return nil, err
	}

	normalized := make([]map[string]any, 0, len(rawRows))
	for _, r := range rawRows {
		normalized = append(normalized, normalizeRow(model, r))
	}

	if len(ast.Include) > 0 && len(normalized) > 0 {
		if err := d.loadRelations(ctx, session, model, normalized, ast.Include); err != nil {
			return nil, err
		}
	}

	return normalized, nil
}

func (d *GormDriver) execCreate(ctx context.Context, session *gorm.DB, model *registry.RegisteredModel, ast protocol.QueryAST) (map[string]any, error) {
	colMap, pkVal, m2mPayloads, err := prepareInsertMap(model, ast.Data)
	if err != nil {
		return nil, err
	}

	if err := session.Table(model.Schema.TableName).Create(colMap).Error; err != nil {
		return nil, err
	}

	if pkVal == nil && model.PrimaryKey.Column != "" {
		pkVal = colMap[model.PrimaryKey.Column]
	}

	// Handle many-to-many join records if provided
	for relName, ids := range m2mPayloads {
		rel, ok := model.Relations[relName]
		if !ok || rel.Kind != "manyToMany" || rel.JoinTable == "" {
			continue
		}
		leftCol := registry.ToSnakeCase(model.Schema.Name) + "_id"
		rightCol := registry.ToSnakeCase(rel.Target) + "_id"
		for _, targetID := range ids {
			joinRow := map[string]any{
				leftCol:  pkVal,
				rightCol: targetID,
			}
			if err := session.Table(rel.JoinTable).Create(joinRow).Error; err != nil {
				return nil, err
			}
		}
	}

	if pkVal != nil && model.PrimaryKey.Name != "" {
		findAST := protocol.QueryAST{
			Model:     model.Schema.Name,
			Operation: "findUnique",
			Where: &protocol.FilterNode{
				Field: model.PrimaryKey.Name,
				Op:    "eq",
				Value: pkVal,
			},
			Select:  ast.Select,
			Include: ast.Include,
		}
		rows, err := d.execFindMany(ctx, session, model, findAST)
		if err == nil && len(rows) > 0 {
			return rows[0], nil
		}
	}

	return normalizeRow(model, colMap), nil
}

func (d *GormDriver) execCreateMany(ctx context.Context, session *gorm.DB, model *registry.RegisteredModel, ast protocol.QueryAST) (int64, error) {
	if len(ast.DataList) == 0 {
		return 0, nil
	}
	batch := make([]map[string]any, 0, len(ast.DataList))
	for _, item := range ast.DataList {
		colMap, _, _, err := prepareInsertMap(model, item)
		if err != nil {
			return 0, err
		}
		batch = append(batch, colMap)
	}
	res := session.Table(model.Schema.TableName).Create(batch)
	return res.RowsAffected, res.Error
}

func (d *GormDriver) execUpdate(ctx context.Context, session *gorm.DB, model *registry.RegisteredModel, ast protocol.QueryAST) (map[string]any, error) {
	existing, err := d.execFindMany(ctx, session, model, protocol.QueryAST{
		Model: model.Schema.Name,
		Where: ast.Where,
		Limit: 1,
	})
	if err != nil {
		return nil, err
	}
	if len(existing) == 0 {
		return nil, fmt.Errorf("NEXUS_NOT_FOUND: no %s record matched update filter", model.Schema.Name)
	}

	updateCols, err := prepareUpdateMap(model, ast.Data)
	if err != nil {
		return nil, err
	}

	whereSQL, whereArgs, err := query.CompileFilter(model, ast.Where)
	if err != nil {
		return nil, err
	}
	tx := session.Table(model.Schema.TableName)
	if whereSQL != "" {
		tx = tx.Where(whereSQL, whereArgs...)
	}
	if err := tx.Updates(updateCols).Error; err != nil {
		return nil, err
	}

	pkName := model.PrimaryKey.Name
	if pkName != "" && existing[0][pkName] != nil {
		updated, err := d.execFindMany(ctx, session, model, protocol.QueryAST{
			Model: model.Schema.Name,
			Where: &protocol.FilterNode{
				Field: pkName,
				Op:    "eq",
				Value: existing[0][pkName],
			},
			Select:  ast.Select,
			Include: ast.Include,
			Limit:   1,
		})
		if err == nil && len(updated) > 0 {
			return updated[0], nil
		}
	}
	return existing[0], nil
}

func (d *GormDriver) execUpdateMany(ctx context.Context, session *gorm.DB, model *registry.RegisteredModel, ast protocol.QueryAST) (int64, error) {
	updateCols, err := prepareUpdateMap(model, ast.Data)
	if err != nil {
		return 0, err
	}
	whereSQL, whereArgs, err := query.CompileFilter(model, ast.Where)
	if err != nil {
		return 0, err
	}
	tx := session.Table(model.Schema.TableName)
	if whereSQL != "" {
		tx = tx.Where(whereSQL, whereArgs...)
	} else {
		tx = tx.Where("1 = 1")
	}
	res := tx.Updates(updateCols)
	return res.RowsAffected, res.Error
}

func (d *GormDriver) execDeleteOne(ctx context.Context, session *gorm.DB, model *registry.RegisteredModel, ast protocol.QueryAST) (map[string]any, error) {
	existing, err := d.execFindMany(ctx, session, model, protocol.QueryAST{
		Model: model.Schema.Name,
		Where: ast.Where,
		Limit: 1,
	})
	if err != nil {
		return nil, err
	}
	if len(existing) == 0 {
		return nil, fmt.Errorf("NEXUS_NOT_FOUND: no %s record matched delete filter", model.Schema.Name)
	}

	whereSQL, whereArgs, err := query.CompileFilter(model, ast.Where)
	if err != nil {
		return nil, err
	}
	tx := session.Table(model.Schema.TableName)
	if whereSQL != "" {
		tx = tx.Where(whereSQL, whereArgs...)
	}
	if err := tx.Delete(map[string]any{}).Error; err != nil {
		return nil, err
	}
	return existing[0], nil
}

func (d *GormDriver) execDeleteMany(ctx context.Context, session *gorm.DB, model *registry.RegisteredModel, ast protocol.QueryAST) (int64, error) {
	whereSQL, whereArgs, err := query.CompileFilter(model, ast.Where)
	if err != nil {
		return 0, err
	}
	tx := session.Table(model.Schema.TableName)
	if whereSQL != "" {
		tx = tx.Where(whereSQL, whereArgs...)
	} else {
		tx = tx.Where("1 = 1")
	}
	res := tx.Delete(map[string]any{})
	return res.RowsAffected, res.Error
}

func (d *GormDriver) execCount(session *gorm.DB, model *registry.RegisteredModel, ast protocol.QueryAST) (int64, error) {
	whereSQL, whereArgs, err := query.CompileFilter(model, ast.Where)
	if err != nil {
		return 0, err
	}
	tx := session.Table(model.Schema.TableName)
	if whereSQL != "" {
		tx = tx.Where(whereSQL, whereArgs...)
	}
	var count int64
	if err := tx.Count(&count).Error; err != nil {
		return 0, err
	}
	return count, nil
}

// loadRelations performs eager loading for oneToOne, oneToMany, manyToOne, and manyToMany relationships.
func (d *GormDriver) loadRelations(
	ctx context.Context,
	session *gorm.DB,
	parentModel *registry.RegisteredModel,
	parentRows []map[string]any,
	includes map[string]protocol.IncludeNode,
) error {
	for relName, incNode := range includes {
		rel, ok := parentModel.Relations[relName]
		if !ok {
			return fmt.Errorf("unknown relation %q on model %q", relName, parentModel.Schema.Name)
		}
		targetModel, ok := d.registry.Get(rel.Target)
		if !ok {
			return fmt.Errorf("target model %q for relation %q is not registered", rel.Target, relName)
		}

		switch rel.Kind {
		case "oneToMany", "oneToOne":
			refField := rel.References
			if refField == "" {
				refField = parentModel.PrimaryKey.Name
			}
			parentIDs := collectDistinctValues(parentRows, refField)
			if len(parentIDs) == 0 {
				continue
			}

			combinedWhere := &protocol.FilterNode{
				Field: rel.ForeignKey,
				Op:    "in",
				Value: parentIDs,
			}
			if incNode.Where != nil {
				combinedWhere = &protocol.FilterNode{
					AND: []protocol.FilterNode{*combinedWhere, *incNode.Where},
				}
			}

			childRows, err := d.execFindMany(ctx, session, targetModel, protocol.QueryAST{
				Model:   targetModel.Schema.Name,
				Where:   combinedWhere,
				Select:  incNode.Select,
				OrderBy: incNode.OrderBy,
				Include: incNode.Include,
			})
			if err != nil {
				return err
			}

			grouped := make(map[string][]map[string]any)
			for _, cr := range childRows {
				fkVal := fmt.Sprintf("%v", cr[rel.ForeignKey])
				grouped[fkVal] = append(grouped[fkVal], cr)
			}

			for _, pr := range parentRows {
				key := fmt.Sprintf("%v", pr[refField])
				matches := grouped[key]
				if rel.Kind == "oneToOne" {
					if len(matches) > 0 {
						pr[relName] = matches[0]
					} else {
						pr[relName] = nil
					}
				} else {
					if matches == nil {
						matches = []map[string]any{}
					}
					if incNode.Limit > 0 && len(matches) > incNode.Limit {
						matches = matches[:incNode.Limit]
					}
					pr[relName] = matches
				}
			}

		case "manyToOne":
			refField := rel.References
			if refField == "" {
				refField = targetModel.PrimaryKey.Name
			}
			fkValues := collectDistinctValues(parentRows, rel.ForeignKey)
			if len(fkValues) == 0 {
				for _, pr := range parentRows {
					pr[relName] = nil
				}
				continue
			}

			combinedWhere := &protocol.FilterNode{
				Field: refField,
				Op:    "in",
				Value: fkValues,
			}
			if incNode.Where != nil {
				combinedWhere = &protocol.FilterNode{
					AND: []protocol.FilterNode{*combinedWhere, *incNode.Where},
				}
			}

			targetRows, err := d.execFindMany(ctx, session, targetModel, protocol.QueryAST{
				Model:   targetModel.Schema.Name,
				Where:   combinedWhere,
				Select:  incNode.Select,
				Include: incNode.Include,
			})
			if err != nil {
				return err
			}

			byID := make(map[string]map[string]any, len(targetRows))
			for _, tr := range targetRows {
				byID[fmt.Sprintf("%v", tr[refField])] = tr
			}

			for _, pr := range parentRows {
				fkVal := pr[rel.ForeignKey]
				if fkVal == nil {
					pr[relName] = nil
					continue
				}
				pr[relName] = byID[fmt.Sprintf("%v", fkVal)]
			}

		case "manyToMany":
			parentPK := parentModel.PrimaryKey.Name
			targetPK := targetModel.PrimaryKey.Name
			parentIDs := collectDistinctValues(parentRows, parentPK)
			if len(parentIDs) == 0 {
				continue
			}

			leftCol := registry.ToSnakeCase(parentModel.Schema.Name) + "_id"
			rightCol := registry.ToSnakeCase(targetModel.Schema.Name) + "_id"

			var joinRows []map[string]any
			if err := session.Table(rel.JoinTable).Where(\`"\`+leftCol+\`" IN ?\`, parentIDs).Find(&joinRows).Error; err != nil {
				return err
			}

			targetIDSet := make([]any, 0, len(joinRows))
			parentToTargets := make(map[string][]string)
			for _, jr := range joinRows {
				lVal := fmt.Sprintf("%v", jr[leftCol])
				rVal := fmt.Sprintf("%v", jr[rightCol])
				parentToTargets[lVal] = append(parentToTargets[lVal], rVal)
				targetIDSet = append(targetIDSet, jr[rightCol])
			}

			var targetRows []map[string]any
			if len(targetIDSet) > 0 {
				combinedWhere := &protocol.FilterNode{
					Field: targetPK,
					Op:    "in",
					Value: targetIDSet,
				}
				if incNode.Where != nil {
					combinedWhere = &protocol.FilterNode{
						AND: []protocol.FilterNode{*combinedWhere, *incNode.Where},
					}
				}
				var err error
				targetRows, err = d.execFindMany(ctx, session, targetModel, protocol.QueryAST{
					Model:   targetModel.Schema.Name,
					Where:   combinedWhere,
					Select:  incNode.Select,
					OrderBy: incNode.OrderBy,
					Include: incNode.Include,
				})
				if err != nil {
					return err
				}
			}

			targetByID := make(map[string]map[string]any, len(targetRows))
			for _, tr := range targetRows {
				targetByID[fmt.Sprintf("%v", tr[targetPK])] = tr
			}

			for _, pr := range parentRows {
				pKey := fmt.Sprintf("%v", pr[parentPK])
				tIDs := parentToTargets[pKey]
				list := make([]map[string]any, 0, len(tIDs))
				for _, tID := range tIDs {
					if item, exists := targetByID[tID]; exists {
						list = append(list, item)
					}
				}
				pr[relName] = list
			}
		}
	}
	return nil
}

func collectDistinctValues(rows []map[string]any, field string) []any {
	seen := make(map[string]bool)
	var out []any
	for _, r := range rows {
		val, ok := r[field]
		if !ok || val == nil {
			continue
		}
		key := fmt.Sprintf("%v", val)
		if !seen[key] {
			seen[key] = true
			out = append(out, val)
		}
	}
	return out
}

func prepareInsertMap(model *registry.RegisteredModel, data map[string]any) (map[string]any, any, map[string][]any, error) {
	colMap := make(map[string]any)
	m2mPayloads := make(map[string][]any)
	var pkVal any

	for k, v := range data {
		if rel, isRel := model.Relations[k]; isRel && rel.Kind == "manyToMany" {
			if slice, ok := v.([]any); ok {
				m2mPayloads[k] = slice
			}
			continue
		}
		fieldSchema, ok := model.FieldsByName[k]
		if !ok {
			return nil, nil, nil, fmt.Errorf("unknown field %q on model %q", k, model.Schema.Name)
		}
		formatted, err := coerceFieldValue(fieldSchema, v)
		if err != nil {
			return nil, nil, nil, err
		}
		colMap[fieldSchema.Column] = formatted
		if fieldSchema.PrimaryKey {
			pkVal = formatted
		}
	}

	// Apply defaults for omitted fields
	for _, f := range model.Schema.Fields {
		if _, exists := colMap[f.Column]; exists {
			continue
		}
		switch f.DefaultKind {
		case "uuid":
			id := uuid.NewString()
			colMap[f.Column] = id
			if f.PrimaryKey {
				pkVal = id
			}
		case "now":
			colMap[f.Column] = time.Now().UTC().Format(time.RFC3339Nano)
		case "static":
			val, err := coerceFieldValue(f, f.DefaultValue)
			if err != nil {
				return nil, nil, nil, err
			}
			colMap[f.Column] = val
		}
	}

	return colMap, pkVal, m2mPayloads, nil
}

func prepareUpdateMap(model *registry.RegisteredModel, data map[string]any) (map[string]any, error) {
	colMap := make(map[string]any)
	for k, v := range data {
		fieldSchema, ok := model.FieldsByName[k]
		if !ok {
			return nil, fmt.Errorf("unknown field %q on model %q", k, model.Schema.Name)
		}
		formatted, err := coerceFieldValue(fieldSchema, v)
		if err != nil {
			return nil, err
		}
		colMap[fieldSchema.Column] = formatted
	}
	return colMap, nil
}

func coerceFieldValue(f protocol.FieldSchema, val any) (any, error) {
	if val == nil {
		return nil, nil
	}
	if f.Type == "json" {
		if str, ok := val.(string); ok {
			return str, nil
		}
		b, err := json.Marshal(val)
		if err != nil {
			return nil, err
		}
		return string(b), nil
	}
	return val, nil
}

func normalizeRow(model *registry.RegisteredModel, raw map[string]any) map[string]any {
	out := make(map[string]any, len(raw))
	for col, val := range raw {
		fieldSchema, ok := model.FieldsByCol[col]
		if !ok {
			out[col] = val
			continue
		}
		if b, isBytes := val.([]byte); isBytes {
			val = string(b)
		}
		if val != nil {
			switch fieldSchema.Type {
			case "boolean":
				switch v := val.(type) {
				case int64:
					val = v != 0
				case int:
					val = v != 0
				case string:
					val = v == "1" || strings.EqualFold(v, "true")
				}
			case "json":
				if str, ok := val.(string); ok && str != "" {
					var parsed any
					if err := json.Unmarshal([]byte(str), &parsed); err == nil {
						val = parsed
					}
				}
			}
		}
		out[fieldSchema.Name] = val
	}
	return out
}

func BuildCreateTableSQL(dialect string, m protocol.ModelSchema) string {
	cols := make([]string, 0, len(m.Fields))
	for _, f := range m.Fields {
		colDef := \`"\` + f.Column + \`" \` + mapSQLType(dialect, f)
		if f.PrimaryKey {
			if f.AutoIncrement && dialect == "sqlite" {
				colDef = \`"\` + f.Column + \`" INTEGER PRIMARY KEY AUTOINCREMENT\`
			} else {
				colDef += " PRIMARY KEY"
			}
		} else {
			if !f.Nullable {
				colDef += " NOT NULL"
			}
			if f.Unique {
				colDef += " UNIQUE"
			}
		}
		if f.References != nil && f.References.Model != "" {
			refTable := registry.ToSnakeCase(f.References.Model) + "s"
			refCol := registry.ToSnakeCase(f.References.Column)
			onDelete := f.References.OnDelete
			if onDelete == "" {
				onDelete = "CASCADE"
			}
			colDef += fmt.Sprintf(\` REFERENCES "%s"("%s") ON DELETE %s\`, refTable, refCol, onDelete)
		}
		cols = append(cols, colDef)
	}
	return fmt.Sprintf(\`CREATE TABLE IF NOT EXISTS "%s" (%s);\`, m.TableName, strings.Join(cols, ", "))
}

func BuildIndexSQL(m protocol.ModelSchema) []string {
	var stmts []string
	for _, f := range m.Fields {
		if f.Index && !f.Unique && !f.PrimaryKey {
			idxName := fmt.Sprintf("idx_%s_%s", m.TableName, f.Column)
			stmts = append(stmts, fmt.Sprintf(\`CREATE INDEX IF NOT EXISTS "%s" ON "%s" ("%s");\`, idxName, m.TableName, f.Column))
		}
	}
	return stmts
}

func BuildJoinTableSQL(joinTable string, left, right protocol.ModelSchema) string {
	leftCol := registry.ToSnakeCase(left.Name) + "_id"
	rightCol := registry.ToSnakeCase(right.Name) + "_id"
	return fmt.Sprintf(
		\`CREATE TABLE IF NOT EXISTS "%s" ("%s" TEXT NOT NULL, "%s" TEXT NOT NULL, PRIMARY KEY ("%s", "%s"));\`,
		joinTable, leftCol, rightCol, leftCol, rightCol,
	)
}

func mapSQLType(dialect string, f protocol.FieldSchema) string {
	if f.AutoIncrement && dialect == "postgres" {
		return "SERIAL"
	}
	switch f.Type {
	case "uuid":
		if dialect == "postgres" {
			return "UUID"
		}
		return "TEXT"
	case "string":
		if f.MaxLength > 0 {
			return fmt.Sprintf("VARCHAR(%d)", f.MaxLength)
		}
		return "TEXT"
	case "integer":
		return "INTEGER"
	case "float":
		if dialect == "postgres" {
			return "DOUBLE PRECISION"
		}
		return "REAL"
	case "boolean":
		return "BOOLEAN"
	case "date", "timestamp":
		if dialect == "postgres" {
			return "TIMESTAMPTZ"
		}
		return "DATETIME"
	case "json":
		if dialect == "postgres" {
			return "JSONB"
		}
		return "TEXT"
	default:
		return "TEXT"
	}
}

func ClassifyDatabaseError(err error, model string) (string, string, bool) {
	if err == nil {
		return "", "", false
	}
	msg := err.Error()
	lower := strings.ToLower(msg)
	switch {
	case strings.Contains(msg, "NEXUS_NOT_FOUND") || strings.Contains(lower, "record not found"):
		return protocol.ErrNotFound, msg, false
	case strings.Contains(lower, "unique") || strings.Contains(lower, "duplicate"):
		return protocol.ErrUniqueViolation, fmt.Sprintf("Unique constraint violation on model %q: %s", model, msg), false
	case strings.Contains(lower, "foreign key"):
		return protocol.ErrForeignKeyViolation, fmt.Sprintf("Foreign key constraint violation on model %q: %s", model, msg), false
	case strings.Contains(lower, "timeout") || strings.Contains(lower, "deadline exceeded"):
		return protocol.ErrTimeout, msg, true
	case strings.Contains(lower, "transaction") && strings.Contains(lower, "expired"):
		return protocol.ErrTxExpired, msg, false
	default:
		return protocol.ErrInternal, msg, false
	}
}
`,

  // ============================================================================
  // PHASE 7: GO MIGRATION ENGINE, INTROSPECTOR & STUDIO SERVER
  // ============================================================================
  "engine/internal/migrator/migrator.go": `package migrator

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"gorm.io/gorm"

	"nexus/engine/internal/backend/gormdrv"
	"nexus/engine/internal/protocol"
)

const HistoryTable = "_nexus_migrations"

type MigrationRecord struct {
	ID              string \`json:"id"\`
	Name            string \`json:"name"\`
	Checksum        string \`json:"checksum"\`
	AppliedAt       string \`json:"appliedAt"\`
	ExecutionTimeMs int64  \`json:"executionTimeMs"\`
}

type MigrationStatus struct {
	Name      string \`json:"name"\`
	Status    string \`json:"status"\` // "applied" | "pending" | "conflict"
	Checksum  string \`json:"checksum"\`
	AppliedAt string \`json:"appliedAt,omitempty"\`
}

type Migrator struct {
	driver *gormdrv.GormDriver
}

func NewMigrator(driver *gormdrv.GormDriver) *Migrator {
	return &Migrator{driver: driver}
}

func (m *Migrator) EnsureHistoryTable(ctx context.Context) error {
	ddl := fmt.Sprintf(\`CREATE TABLE IF NOT EXISTS "%s" (
		"id" TEXT PRIMARY KEY,
		"name" TEXT NOT NULL UNIQUE,
		"checksum" TEXT NOT NULL,
		"applied_at" TEXT NOT NULL,
		"execution_time_ms" INTEGER NOT NULL
	);\`, HistoryTable)
	return m.driver.DB().WithContext(ctx).Exec(ddl).Error
}

func ComputeChecksum(content string) string {
	Normalized := strings.ReplaceAll(content, "\\r\\n", "\\n")
	sum := sha256.Sum256([]byte(Normalized))
	return hex.EncodeToString(sum[:])
}

func ParseUpAndDownSQL(content string) (string, string) {
	upMarker := "-- +nexus Up"
	downMarker := "-- +nexus Down"

	upIdx := strings.Index(content, upMarker)
	downIdx := strings.Index(content, downMarker)

	if upIdx == -1 {
		return strings.TrimSpace(content), ""
	}
	if downIdx == -1 {
		return strings.TrimSpace(content[upIdx+len(upMarker):]), ""
	}
	upSQL := strings.TrimSpace(content[upIdx+len(upMarker) : downIdx])
	downSQL := strings.TrimSpace(content[downIdx+len(downMarker):])
	return upSQL, downSQL
}

func (m *Migrator) GenerateMigrationFile(migrationsDir, migrationName string) (string, string, error) {
	if err := os.MkdirAll(migrationsDir, 0755); err != nil {
		return "", "", err
	}
	var upStmts []string
	var downStmts []string

	models := m.driver.Registry().All()
	sort.Slice(models, func(i, j int) bool {
		return models[i].Schema.Name < models[j].Schema.Name
	})

	for _, model := range models {
		upStmts = append(upStmts, gormdrv.BuildCreateTableSQL(m.driver.Dialect(), model.Schema))
		upStmts = append(upStmts, gormdrv.BuildIndexSQL(model.Schema)...)
		for _, rel := range model.Schema.Relations {
			if rel.Kind == "manyToMany" && rel.JoinTable != "" {
				if target, ok := m.driver.Registry().Get(rel.Target); ok {
					upStmts = append(upStmts, gormdrv.BuildJoinTableSQL(rel.JoinTable, model.Schema, target.Schema))
					downStmts = append([]string{fmt.Sprintf(\`DROP TABLE IF EXISTS "%s";\`, rel.JoinTable)}, downStmts...)
				}
			}
		}
		downStmts = append([]string{fmt.Sprintf(\`DROP TABLE IF EXISTS "%s";\`, model.Schema.TableName)}, downStmts...)
	}

	timestamp := time.Now().UTC().Format("20060102150405")
	safeName := strings.ReplaceAll(strings.ToLower(strings.TrimSpace(migrationName)), " ", "_")
	if safeName == "" {
		safeName = "schema_sync"
	}
	fileName := fmt.Sprintf("%s_%s.sql", timestamp, safeName)
	fullPath := filepath.Join(migrationsDir, fileName)

	var content strings.Builder
	content.WriteString("-- +nexus Up\\n")
	for _, stmt := range upStmts {
		content.WriteString(stmt + "\\n")
	}
	content.WriteString("\\n-- +nexus Down\\n")
	for _, stmt := range downStmts {
		content.WriteString(stmt + "\\n")
	}

	if err := os.WriteFile(fullPath, []byte(content.String()), 0644); err != nil {
		return "", "", err
	}
	return fullPath, content.String(), nil
}

func (m *Migrator) Status(ctx context.Context, migrationsDir string) ([]MigrationStatus, error) {
	if err := m.EnsureHistoryTable(ctx); err != nil {
		return nil, err
	}
	applied, err := m.loadApplied(ctx)
	if err != nil {
		return nil, err
	}
	files, err := listSQLFiles(migrationsDir)
	if err != nil {
		return nil, err
	}

	appliedMap := make(map[string]MigrationRecord, len(applied))
	for _, rec := range applied {
		appliedMap[rec.Name] = rec
	}

	var statuses []MigrationStatus
	for _, f := range files {
		raw, err := os.ReadFile(filepath.Join(migrationsDir, f))
		if err != nil {
			return nil, err
		}
		checksum := ComputeChecksum(string(raw))
		if rec, ok := appliedMap[f]; ok {
			status := "applied"
			if rec.Checksum != checksum {
				status = "conflict"
			}
			statuses = append(statuses, MigrationStatus{
				Name:      f,
				Status:    status,
				Checksum:  checksum,
				AppliedAt: rec.AppliedAt,
			})
		} else {
			statuses = append(statuses, MigrationStatus{
				Name:     f,
				Status:   "pending",
				Checksum: checksum,
			})
		}
	}
	return statuses, nil
}

func (m *Migrator) ApplyUp(ctx context.Context, migrationsDir string) ([]string, error) {
	statuses, err := m.Status(ctx, migrationsDir)
	if err != nil {
		return nil, err
	}
	for _, s := range statuses {
		if s.Status == "conflict" {
			return nil, fmt.Errorf("%s: migration %q checksum mismatch against applied history", protocol.ErrMigrationConflict, s.Name)
		}
	}

	var newlyApplied []string
	for _, s := range statuses {
		if s.Status != "pending" {
			continue
		}
		raw, err := os.ReadFile(filepath.Join(migrationsDir, s.Name))
		if err != nil {
			return newlyApplied, err
		}
		upSQL, _ := ParseUpAndDownSQL(string(raw))
		start := time.Now()

		err = m.driver.DB().WithContext(ctx).Transaction(func(tx *gorm.DB) error {
			for _, stmt := range splitSQLStatements(upSQL) {
				if err := tx.Exec(stmt).Error; err != nil {
					return err
				}
			}
			elapsed := time.Since(start).Milliseconds()
			return tx.Table(HistoryTable).Create(map[string]any{
				"id":                s.Name,
				"name":              s.Name,
				"checksum":          s.Checksum,
				"applied_at":        time.Now().UTC().Format(time.RFC3339),
				"execution_time_ms": elapsed,
			}).Error
		})
		if err != nil {
			return newlyApplied, err
		}
		newlyApplied = append(newlyApplied, s.Name)
	}
	return newlyApplied, nil
}

func (m *Migrator) RollbackLast(ctx context.Context, migrationsDir string) (string, error) {
	if err := m.EnsureHistoryTable(ctx); err != nil {
		return "", err
	}
	applied, err := m.loadApplied(ctx)
	if err != nil {
		return "", err
	}
	if len(applied) == 0 {
		return "", nil
	}
	last := applied[len(applied)-1]
	raw, err := os.ReadFile(filepath.Join(migrationsDir, last.Name))
	if err != nil {
		return "", err
	}
	_, downSQL := ParseUpAndDownSQL(string(raw))

	err = m.driver.DB().WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		for _, stmt := range splitSQLStatements(downSQL) {
			if err := tx.Exec(stmt).Error; err != nil {
				return err
			}
		}
		return tx.Table(HistoryTable).Where(\`"name" = ?\`, last.Name).Delete(map[string]any{}).Error
	})
	if err != nil {
		return "", err
	}
	return last.Name, nil
}

func (m *Migrator) Reset(ctx context.Context, migrationsDir string, confirmed bool) ([]string, error) {
	if !confirmed {
		return nil, fmt.Errorf("destructive reset requires explicit confirmation flag")
	}
	if err := m.EnsureHistoryTable(ctx); err != nil {
		return nil, err
	}
	applied, err := m.loadApplied(ctx)
	if err != nil {
		return nil, err
	}
	for i := len(applied) - 1; i >= 0; i-- {
		if _, err := m.RollbackLast(ctx, migrationsDir); err != nil {
			return nil, err
		}
	}
	return m.ApplyUp(ctx, migrationsDir)
}

func (m *Migrator) loadApplied(ctx context.Context) ([]MigrationRecord, error) {
	var rows []map[string]any
	err := m.driver.DB().WithContext(ctx).Table(HistoryTable).Order(\`"name" ASC\`).Find(&rows).Error
	if err != nil {
		return nil, err
	}
	records := make([]MigrationRecord, 0, len(rows))
	for _, r := range rows {
		records = append(records, MigrationRecord{
			ID:        fmt.Sprintf("%v", r["id"]),
			Name:      fmt.Sprintf("%v", r["name"]),
			Checksum:  fmt.Sprintf("%v", r["checksum"]),
			AppliedAt: fmt.Sprintf("%v", r["applied_at"]),
		})
	}
	return records, nil
}

func listSQLFiles(dir string) ([]string, error) {
	entries, err := os.ReadDir(dir)
	if os.IsNotExist(err) {
		return []string{}, nil
	}
	if err != nil {
		return nil, err
	}
	var names []string
	for _, e := range entries {
		if !e.IsDir() && strings.HasSuffix(e.Name(), ".sql") {
			names = append(names, e.Name())
		}
	}
	sort.Strings(names)
	return names, nil
}

func splitSQLStatements(sqlBlock string) []string {
	rawParts := strings.Split(sqlBlock, ";")
	var stmts []string
	for _, p := range rawParts {
		trimmed := strings.TrimSpace(p)
		if trimmed != "" {
			stmts = append(stmts, trimmed+";")
		}
	}
	return stmts
}
`,

  "engine/internal/introspect/introspect.go": `package introspect

import (
	"context"
	"strings"

	"nexus/engine/internal/backend/gormdrv"
	"nexus/engine/internal/migrator"
	"nexus/engine/internal/protocol"
)

type Introspector struct {
	driver *gormdrv.GormDriver
}

func NewIntrospector(driver *gormdrv.GormDriver) *Introspector {
	return &Introspector{driver: driver}
}

func (in *Introspector) IntrospectSchema(ctx context.Context) (protocol.SchemaManifest, error) {
	mig := in.driver.DB().WithContext(ctx).Migrator()
	tables, err := mig.GetTables()
	if err != nil {
		return protocol.SchemaManifest{}, err
	}

	var models []protocol.ModelSchema
	for _, tbl := range tables {
		if tbl == migrator.HistoryTable || strings.HasPrefix(tbl, "sqlite_") {
			continue
		}
		colTypes, err := mig.ColumnTypes(tbl)
		if err != nil {
			return protocol.SchemaManifest{}, err
		}

		var fields []protocol.FieldSchema
		for _, ct := range colTypes {
			nullable, _ := ct.Nullable()
			pk, _ := ct.PrimaryKey()
			unique, _ := ct.Unique()
			autoInc, _ := ct.AutoIncrement()

			fields = append(fields, protocol.FieldSchema{
				Name:          snakeToCamel(ct.Name()),
				Column:        ct.Name(),
				Type:          mapDBTypeToNexus(ct.DatabaseTypeName()),
				PrimaryKey:    pk,
				Unique:        unique,
				Nullable:      nullable && !pk,
				AutoIncrement: autoInc,
			})
		}

		models = append(models, protocol.ModelSchema{
			Name:      tableToModelName(tbl),
			TableName: tbl,
			Fields:    fields,
		})
	}

	return protocol.SchemaManifest{Models: models}, nil
}

func mapDBTypeToNexus(dbType string) string {
	upper := strings.ToUpper(dbType)
	switch {
	case strings.Contains(upper, "UUID"):
		return "uuid"
	case strings.Contains(upper, "INT"):
		return "integer"
	case strings.Contains(upper, "REAL") || strings.Contains(upper, "FLOAT") || strings.Contains(upper, "DOUBLE"):
		return "float"
	case strings.Contains(upper, "BOOL"):
		return "boolean"
	case strings.Contains(upper, "DATE") || strings.Contains(upper, "TIME"):
		return "date"
	case strings.Contains(upper, "JSON"):
		return "json"
	default:
		return "string"
	}
}

func snakeToCamel(s string) string {
	parts := strings.Split(s, "_")
	for i := 1; i < len(parts); i++ {
		if len(parts[i]) > 0 {
			parts[i] = strings.ToUpper(parts[i][:1]) + parts[i][1:]
		}
	}
	return strings.Join(parts, "")
}

func tableToModelName(tbl string) string {
	singular := strings.TrimSuffix(tbl, "s")
	camel := snakeToCamel(singular)
	if len(camel) == 0 {
		return "Model"
	}
	return strings.ToUpper(camel[:1]) + camel[1:]
}
`,

  "engine/internal/studio/server.go": `package studio

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"

	"nexus/engine/internal/backend/gormdrv"
	"nexus/engine/internal/protocol"
)

type Server struct {
	driver *gormdrv.GormDriver
	srv    *http.Server
}

func NewServer(driver *gormdrv.GormDriver) *Server {
	return &Server{driver: driver}
}

func (s *Server) Start(port int) (string, error) {
	if port <= 0 {
		port = 4983
	}
	mux := http.NewServeMux()

	mux.HandleFunc("/api/models", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		models := s.driver.Registry().All()
		schemas := make([]protocol.ModelSchema, 0, len(models))
		for _, m := range models {
			schemas = append(schemas, m.Schema)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"models": schemas})
	})

	mux.HandleFunc("/api/records", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		modelName := r.URL.Query().Get("model")
		res, err := s.driver.ExecuteQuery(r.Context(), protocol.QueryAST{
			Model:     modelName,
			Operation: "findMany",
			Limit:     100,
		})
		if err != nil {
			w.WriteHeader(http.StatusBadRequest)
			_ = json.NewEncoder(w).Encode(map[string]any{"error": err.Error()})
			return
		}
		_ = json.NewEncoder(w).Encode(res)
	})

	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = fmt.Fprint(w, "<!doctype html><html><head><title>Nexus Studio</title></head><body><h1>Nexus Studio</h1><p>API endpoints active at <code>/api/models</code> and <code>/api/records?model=ModelName</code></p></body></html>")
	})

	addr := fmt.Sprintf("127.0.0.1:%d", port)
	s.srv = &http.Server{Addr: addr, Handler: mux}
	go func() {
		_ = s.srv.ListenAndServe()
	}()
	return "http://" + addr, nil
}

func (s *Server) Stop(ctx context.Context) error {
	if s.srv == nil {
		return nil
	}
	return s.srv.Shutdown(ctx)
}
`,

  // ============================================================================
  // GO ENGINE DAEMON ENTRY POINT (cmd/nexus-engine/main.go)
  // ============================================================================
  "engine/cmd/nexus-engine/main.go": `package main

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"sync"
	"time"

	"nexus/engine/internal/backend/gormdrv"
	"nexus/engine/internal/introspect"
	"nexus/engine/internal/migrator"
	"nexus/engine/internal/protocol"
	"nexus/engine/internal/registry"
	"nexus/engine/internal/studio"
)

type EngineDaemon struct {
	writeMu      sync.Mutex
	reg          *registry.Registry
	driver       *gormdrv.GormDriver
	migrator     *migrator.Migrator
	introspector *introspect.Introspector
	studio       *studio.Server
}

func NewEngineDaemon() *EngineDaemon {
	reg := registry.NewRegistry()
	drv := gormdrv.NewGormDriver(reg)
	return &EngineDaemon{
		reg:          reg,
		driver:       drv,
		migrator:     migrator.NewMigrator(drv),
		introspector: introspect.NewIntrospector(drv),
		studio:       studio.NewServer(drv),
	}
}

func (e *EngineDaemon) send(resp protocol.Response) {
	e.writeMu.Lock()
	defer e.writeMu.Unlock()
	bytes, err := json.Marshal(resp)
	if err != nil {
		fmt.Fprintf(os.Stderr, \`{"level":"error","msg":"marshal failure: %v"}\`+"\\n", err)
		return
	}
	_, _ = os.Stdout.Write(append(bytes, '\\n'))
}

func (e *EngineDaemon) handleRequest(req protocol.Request) {
	timeout := 15 * time.Second
	if req.TimeoutMs > 0 {
		timeout = time.Duration(req.TimeoutMs) * time.Millisecond
	}
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()

	switch req.Method {
	case "engine.handshake":
		var hs protocol.HandshakeRequest
		_ = json.Unmarshal(req.Params, &hs)
		if hs.ProtocolVersion != protocol.ProtocolVersion {
			e.send(protocol.NewErrorResponse(req.ID, protocol.ErrVersionMismatch,
				fmt.Sprintf("protocol mismatch: client=%d engine=%d", hs.ProtocolVersion, protocol.ProtocolVersion),
				"", nil, false))
			return
		}
		e.send(protocol.NewSuccessResponse(req.ID, protocol.HandshakeResponse{
			EngineVersion:   protocol.EngineVersion,
			ProtocolVersion: protocol.ProtocolVersion,
		}))

	case "engine.connect":
		var cfg protocol.ConnectionConfig
		if err := json.Unmarshal(req.Params, &cfg); err != nil {
			e.send(protocol.NewErrorResponse(req.ID, protocol.ErrConfigInvalid, err.Error(), "", nil, false))
			return
		}
		if err := e.driver.Connect(ctx, cfg); err != nil {
			e.send(protocol.NewErrorResponse(req.ID, protocol.ErrConnectionFailed, err.Error(), "", nil, true))
			return
		}
		e.send(protocol.NewSuccessResponse(req.ID, map[string]any{"connected": true, "dialect": cfg.Dialect}))

	case "schema.register":
		var manifest protocol.SchemaManifest
		if err := json.Unmarshal(req.Params, &manifest); err != nil {
			e.send(protocol.NewErrorResponse(req.ID, protocol.ErrValidation, err.Error(), "", nil, false))
			return
		}
		if err := e.driver.RegisterSchema(ctx, manifest); err != nil {
			e.send(protocol.NewErrorResponse(req.ID, protocol.ErrValidation, err.Error(), "", nil, false))
			return
		}
		e.send(protocol.NewSuccessResponse(req.ID, map[string]any{"registeredModels": len(manifest.Models)}))

	case "schema.push":
		if err := e.driver.PushSchema(ctx); err != nil {
			e.send(protocol.NewErrorResponse(req.ID, protocol.ErrInternal, err.Error(), "", nil, false))
			return
		}
		e.send(protocol.NewSuccessResponse(req.ID, map[string]any{"pushed": true}))

	case "schema.introspect":
		manifest, err := e.introspector.IntrospectSchema(ctx)
		if err != nil {
			e.send(protocol.NewErrorResponse(req.ID, protocol.ErrInternal, err.Error(), "", nil, false))
			return
		}
		e.send(protocol.NewSuccessResponse(req.ID, manifest))

	case "query.execute":
		var ast protocol.QueryAST
		if err := json.Unmarshal(req.Params, &ast); err != nil {
			e.send(protocol.NewErrorResponse(req.ID, protocol.ErrValidation, err.Error(), "", nil, false))
			return
		}
		res, err := e.driver.ExecuteQuery(ctx, ast)
		if err != nil {
			code, msg, retryable := gormdrv.ClassifyDatabaseError(err, ast.Model)
			e.send(protocol.NewErrorResponse(req.ID, code, msg, ast.Model, nil, retryable))
			return
		}
		e.send(protocol.NewSuccessResponse(req.ID, res))

	case "tx.begin":
		var opts protocol.TxOptions
		_ = json.Unmarshal(req.Params, &opts)
		txID, err := e.driver.BeginTx(ctx, opts)
		if err != nil {
			e.send(protocol.NewErrorResponse(req.ID, protocol.ErrInternal, err.Error(), "", nil, false))
			return
		}
		e.send(protocol.NewSuccessResponse(req.ID, map[string]any{"txId": txID}))

	case "tx.commit":
		var payload struct {
			TxID string \`json:"txId"\`
		}
		_ = json.Unmarshal(req.Params, &payload)
		if err := e.driver.CommitTx(ctx, payload.TxID); err != nil {
			e.send(protocol.NewErrorResponse(req.ID, protocol.ErrTxExpired, err.Error(), "", nil, false))
			return
		}
		e.send(protocol.NewSuccessResponse(req.ID, map[string]any{"committed": true}))

	case "tx.rollback":
		var payload struct {
			TxID string \`json:"txId"\`
		}
		_ = json.Unmarshal(req.Params, &payload)
		if err := e.driver.RollbackTx(ctx, payload.TxID); err != nil {
			e.send(protocol.NewErrorResponse(req.ID, protocol.ErrTxExpired, err.Error(), "", nil, false))
			return
		}
		e.send(protocol.NewSuccessResponse(req.ID, map[string]any{"rolledBack": true}))

	case "migrate.generate":
		var payload struct {
			Dir  string \`json:"dir"\`
			Name string \`json:"name"\`
		}
		_ = json.Unmarshal(req.Params, &payload)
		filePath, sqlContent, err := e.migrator.GenerateMigrationFile(payload.Dir, payload.Name)
		if err != nil {
			e.send(protocol.NewErrorResponse(req.ID, protocol.ErrInternal, err.Error(), "", nil, false))
			return
		}
		e.send(protocol.NewSuccessResponse(req.ID, map[string]any{"filePath": filePath, "sql": sqlContent}))

	case "migrate.up":
		var payload struct {
			Dir string \`json:"dir"\`
		}
		_ = json.Unmarshal(req.Params, &payload)
		applied, err := e.migrator.ApplyUp(ctx, payload.Dir)
		if err != nil {
			code := protocol.ErrInternal
			if len(err.Error()) >= len(protocol.ErrMigrationConflict) && err.Error()[:len(protocol.ErrMigrationConflict)] == protocol.ErrMigrationConflict {
				code = protocol.ErrMigrationConflict
			}
			e.send(protocol.NewErrorResponse(req.ID, code, err.Error(), "", nil, false))
			return
		}
		e.send(protocol.NewSuccessResponse(req.ID, map[string]any{"applied": applied}))

	case "migrate.rollback":
		var payload struct {
			Dir string \`json:"dir"\`
		}
		_ = json.Unmarshal(req.Params, &payload)
		reverted, err := e.migrator.RollbackLast(ctx, payload.Dir)
		if err != nil {
			e.send(protocol.NewErrorResponse(req.ID, protocol.ErrInternal, err.Error(), "", nil, false))
			return
		}
		e.send(protocol.NewSuccessResponse(req.ID, map[string]any{"reverted": reverted}))

	case "migrate.status":
		var payload struct {
			Dir string \`json:"dir"\`
		}
		_ = json.Unmarshal(req.Params, &payload)
		statuses, err := e.migrator.Status(ctx, payload.Dir)
		if err != nil {
			e.send(protocol.NewErrorResponse(req.ID, protocol.ErrInternal, err.Error(), "", nil, false))
			return
		}
		e.send(protocol.NewSuccessResponse(req.ID, map[string]any{"migrations": statuses}))

	case "migrate.reset":
		var payload struct {
			Dir       string \`json:"dir"\`
			Confirmed bool   \`json:"confirmed"\`
		}
		_ = json.Unmarshal(req.Params, &payload)
		applied, err := e.migrator.Reset(ctx, payload.Dir, payload.Confirmed)
		if err != nil {
			e.send(protocol.NewErrorResponse(req.ID, protocol.ErrValidation, err.Error(), "", nil, false))
			return
		}
		e.send(protocol.NewSuccessResponse(req.ID, map[string]any{"applied": applied}))

	case "studio.start":
		var payload struct {
			Port int \`json:"port"\`
		}
		_ = json.Unmarshal(req.Params, &payload)
		url, err := e.studio.Start(payload.Port)
		if err != nil {
			e.send(protocol.NewErrorResponse(req.ID, protocol.ErrInternal, err.Error(), "", nil, false))
			return
		}
		e.send(protocol.NewSuccessResponse(req.ID, map[string]any{"url": url}))

	case "engine.ping":
		if err := e.driver.Ping(ctx); err != nil {
			e.send(protocol.NewErrorResponse(req.ID, protocol.ErrConnectionFailed, err.Error(), "", nil, true))
			return
		}
		e.send(protocol.NewSuccessResponse(req.ID, map[string]any{"pong": true}))

	case "engine.shutdown":
		_ = e.studio.Stop(ctx)
		_ = e.driver.Close()
		e.send(protocol.NewSuccessResponse(req.ID, map[string]any{"shutdown": true}))
		os.Exit(0)

	default:
		e.send(protocol.NewErrorResponse(req.ID, protocol.ErrValidation, "unknown method: "+req.Method, "", nil, false))
	}
}

func main() {
	daemon := NewEngineDaemon()
	scanner := bufio.NewScanner(os.Stdin)
	buf := make([]byte, 0, 1024*1024)
	scanner.Buffer(buf, 16*1024*1024)

	for scanner.Scan() {
		line := scanner.Bytes()
		if len(line) == 0 {
			continue
		}
		var req protocol.Request
		if err := json.Unmarshal(line, &req); err != nil {
			daemon.send(protocol.NewErrorResponse("unknown", protocol.ErrValidation, "malformed JSON-RPC line: "+err.Error(), "", nil, false))
			continue
		}
		go daemon.handleRequest(req)
	}
	_ = daemon.driver.Close()
}
`,

  // ============================================================================
  // PHASE 9 (GO TESTS): END-TO-END SQLITE GORM DRIVER & MIGRATOR TESTS
  // ============================================================================
  "engine/internal/backend/gormdrv/driver_test.go": `package gormdrv_test

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

	// 1. Create User
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

	// 2. Create Post linked to User
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

	// 3. FindMany with eager loading (User -> posts)
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

	// 4. Transaction Commit & Rollback
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

	// Tamper with migration file to verify conflict detection
	_ = os.WriteFile(filePath, []byte("-- +nexus Up\\nSELECT 1;\\n"), 0644)
	_, err = mig.ApplyUp(ctx, tmpDir)
	if err == nil {
		t.Fatalf("expected checksum conflict error when migration file is modified after apply")
	}
}
`,

  // ============================================================================
  // TYPESCRIPT LAYER: @nexus-orm/core
  // ============================================================================
  "packages/core/src/errors/index.ts": `export type NexusErrorCode =
  | "NEXUS_VERSION_MISMATCH"
  | "NEXUS_CONFIG_INVALID"
  | "NEXUS_CONNECTION_FAILED"
  | "NEXUS_UNIQUE_VIOLATION"
  | "NEXUS_FOREIGN_KEY_VIOLATION"
  | "NEXUS_NOT_FOUND"
  | "NEXUS_TIMEOUT"
  | "NEXUS_TX_EXPIRED"
  | "NEXUS_MIGRATION_CONFLICT"
  | "NEXUS_VALIDATION_ERROR"
  | "NEXUS_ENGINE_CRASHED"
  | "NEXUS_INTERNAL_ERROR";

export interface ProtocolErrorDetail {
  code: NexusErrorCode;
  message: string;
  model?: string;
  fields?: string[];
  retryable: boolean;
}

const URL_CRED_REGEX = /([a-zA-Z0-9+.-]+:\\/\\/[^:/\\s]+:)([^@\\s]+)(@)/g;
const KV_PASS_REGEX = /(password|passwd|pwd|secret)=([^\\s&;]+)/gi;

export function scrubCredentials(input: string): string {
  return input
    .replace(URL_CRED_REGEX, "$1[REDACTED]$3")
    .replace(KV_PASS_REGEX, "$1=[REDACTED]");
}

export class NexusError extends Error {
  public readonly code: NexusErrorCode;
  public readonly model?: string;
  public readonly fields?: string[];
  public readonly retryable: boolean;

  constructor(detail: ProtocolErrorDetail) {
    super(scrubCredentials(detail.message));
    this.name = "NexusError";
    this.code = detail.code;
    this.model = detail.model;
    this.fields = detail.fields;
    this.retryable = detail.retryable;
  }

  static fromProtocol(detail: ProtocolErrorDetail): NexusError {
    return new NexusError(detail);
  }
}
`,

  "packages/core/src/config/index.ts": `import fs from "node:fs";
import path from "node:path";
import { createJiti } from "jiti";
import { z } from "zod";
import { NexusError, scrubCredentials } from "../errors/index.js";

export const PoolConfigSchema = z
  .object({
    min: z.number().int().nonnegative().default(2),
    max: z.number().int().positive().default(10),
    idleTimeoutMs: z.number().int().positive().default(30_000),
  })
  .refine((p) => p.max >= p.min, {
    message: "Connection pool 'max' must be greater than or equal to 'min'",
  });

export const ConnectionConfigSchema = z.object({
  url: z.string().min(1, "Database connection URL is required"),
  pool: PoolConfigSchema.default({ min: 2, max: 10, idleTimeoutMs: 30_000 }),
});

export const LoggingConfigSchema = z.object({
  enabled: z.boolean().default(true),
  level: z.enum(["debug", "info", "warn", "error"]).default("warn"),
});

export const NexusConfigSchema = z.object({
  dialect: z.enum(["postgres", "sqlite", "mysql"]),
  env: z.enum(["development", "production", "test"]).default("development"),
  connection: ConnectionConfigSchema,
  models: z.string().default("./src/models"),
  migrations: z.string().default("./migrations"),
  logging: LoggingConfigSchema.default({ enabled: true, level: "warn" }),
  engineBinaryPath: z.string().optional(),
});

export type NexusConfigInput = z.input<typeof NexusConfigSchema>;
export type NexusConfig = z.output<typeof NexusConfigSchema>;

export function defineConfig<T extends NexusConfigInput>(config: T): NexusConfig {
  const parsed = NexusConfigSchema.safeParse(config);
  if (!parsed.success) {
    const issue = parsed.error.issues
      .map((i) => \`\${i.path.join(".") || "config"}: \${i.message}\`)
      .join("; ");
    throw new NexusError({
      code: "NEXUS_CONFIG_INVALID",
      message: \`Invalid Nexus configuration: \${scrubCredentials(issue)}\`,
      retryable: false,
    });
  }
  return parsed.data;
}

export async function loadConfig(cwd: string = process.cwd(), explicitFile?: string): Promise<NexusConfig> {
  const candidates = explicitFile
    ? [explicitFile]
    : ["nexus.config.ts", "nexus.config.mts", "nexus.config.mjs", "nexus.config.js"];

  let foundPath: string | undefined;
  for (const candidate of candidates) {
    const abs = path.resolve(cwd, candidate);
    if (fs.existsSync(abs)) {
      foundPath = abs;
      break;
    }
  }

  if (!foundPath) {
    throw new NexusError({
      code: "NEXUS_CONFIG_INVALID",
      message: \`Could not locate nexus.config.ts in \${cwd}. Run 'nexus init' to create one.\`,
      retryable: false,
    });
  }

  const jiti = createJiti(import.meta.url, { interopDefault: true });
  const mod = (await jiti.import(foundPath)) as Record<string, unknown> | NexusConfigInput;
  const rawConfig =
    mod && typeof mod === "object" && "default" in mod
      ? (mod.default as NexusConfigInput)
      : mod && typeof mod === "object" && "config" in mod
        ? (mod.config as NexusConfigInput)
        : (mod as NexusConfigInput);

  return defineConfig(rawConfig);
}
`,

  "packages/core/src/schema/index.ts": `export type FieldDataType =
  | "string"
  | "integer"
  | "float"
  | "boolean"
  | "uuid"
  | "date"
  | "timestamp"
  | "json";

export interface ReferenceMeta {
  model: string;
  column: string;
  onDelete?: "CASCADE" | "SET NULL" | "RESTRICT" | "NO ACTION";
}

export interface FieldMeta {
  name: string;
  column: string;
  type: FieldDataType;
  primaryKey: boolean;
  unique: boolean;
  nullable: boolean;
  index: boolean;
  autoIncrement: boolean;
  maxLength?: number;
  defaultKind: "none" | "static" | "now" | "uuid";
  defaultValue?: unknown;
  references?: ReferenceMeta;
}

export class FieldBuilder<
  TType,
  TNullable extends boolean = false,
  THasDefault extends boolean = false,
> {
  public readonly meta: Omit<FieldMeta, "name">;
  declare readonly __tsType: TType;
  declare readonly __nullable: TNullable;
  declare readonly __hasDefault: THasDefault;

  constructor(type: FieldDataType, overrides: Partial<Omit<FieldMeta, "name">> = {}) {
    this.meta = {
      column: "",
      type,
      primaryKey: false,
      unique: false,
      nullable: false,
      index: false,
      autoIncrement: false,
      defaultKind: "none",
      ...overrides,
    };
  }

  private clone<N = TType, Null extends boolean = TNullable, Def extends boolean = THasDefault>(
    patch: Partial<Omit<FieldMeta, "name">>
  ): FieldBuilder<N, Null, Def> {
    return new FieldBuilder<N, Null, Def>(this.meta.type, { ...this.meta, ...patch });
  }

  column(columnName: string): FieldBuilder<TType, TNullable, THasDefault> {
    return this.clone({ column: columnName });
  }

  primaryKey(): FieldBuilder<TType, TNullable, THasDefault> {
    return this.clone({ primaryKey: true });
  }

  unique(): FieldBuilder<TType, TNullable, THasDefault> {
    return this.clone({ unique: true });
  }

  index(): FieldBuilder<TType, TNullable, THasDefault> {
    return this.clone({ index: true });
  }

  nullable(): FieldBuilder<TType, true, true> {
    return this.clone<TType, true, true>({ nullable: true });
  }

  default(value: TType): FieldBuilder<TType, TNullable, true> {
    return this.clone<TType, TNullable, true>({
      defaultKind: "static",
      defaultValue: value,
    });
  }

  defaultNow(): FieldBuilder<TType, TNullable, true> {
    return this.clone<TType, TNullable, true>({ defaultKind: "now" });
  }

  defaultRandom(): FieldBuilder<TType, TNullable, true> {
    return this.clone<TType, TNullable, true>({ defaultKind: "uuid" });
  }

  autoIncrement(): FieldBuilder<TType, TNullable, true> {
    return this.clone<TType, TNullable, true>({ autoIncrement: true });
  }

  references(
    targetModel: () => ModelDefinition<string, Record<string, AnyFieldBuilder>, Record<string, RelationMeta>>,
    targetColumn: string = "id",
    options?: { onDelete?: ReferenceMeta["onDelete"] }
  ): FieldBuilder<TType, TNullable, THasDefault> {
    const resolved = targetModel();
    return this.clone({
      references: {
        model: resolved.name,
        column: targetColumn,
        onDelete: options?.onDelete ?? "CASCADE",
      },
    });
  }
}

export type AnyFieldBuilder = FieldBuilder<any, any, any>;

export const field = {
  string(opts?: { maxLength?: number }) {
    return new FieldBuilder<string>("string", { maxLength: opts?.maxLength });
  },
  integer() {
    return new FieldBuilder<number>("integer");
  },
  float() {
    return new FieldBuilder<number>("float");
  },
  boolean() {
    return new FieldBuilder<boolean>("boolean");
  },
  uuid() {
    return new FieldBuilder<string>("uuid");
  },
  date() {
    return new FieldBuilder<Date | string>("date");
  },
  timestamp() {
    return new FieldBuilder<Date | string>("timestamp");
  },
  json<T = Record<string, unknown>>() {
    return new FieldBuilder<T>("json");
  },
};

export type RelationKind = "oneToOne" | "oneToMany" | "manyToOne" | "manyToMany";

export interface RelationMeta<TTargetModel extends AnyModelDefinition = AnyModelDefinition, TKind extends RelationKind = RelationKind> {
  name: string;
  kind: TKind;
  target: string;
  targetModel?: () => TTargetModel;
  foreignKey: string;
  references: string;
  joinTable?: string;
}

export interface ModelOptions {
  tableName?: string;
  relations?: Record<string, Omit<RelationMeta, "name">>;
}

export interface ModelDefinition<
  TName extends string = string,
  TFields extends Record<string, AnyFieldBuilder> = Record<string, AnyFieldBuilder>,
  TRelations extends Record<string, RelationMeta> = Record<string, RelationMeta>,
> {
  readonly name: TName;
  readonly tableName: string;
  readonly fields: TFields;
  readonly relations: TRelations;
  readonly $InferSelect: InferSelectModel<TFields>;
  readonly $InferInsert: InferInsertModel<TFields>;
}

export type AnyModelDefinition = ModelDefinition<any, any, any>;

type Simplify<T> = { [K in keyof T]: T[K] } & {};

export type InferFieldSelect<F extends AnyFieldBuilder> = F["__nullable"] extends true
  ? F["__tsType"] | null
  : F["__tsType"];

export type InferSelectModel<TFields extends Record<string, AnyFieldBuilder>> = Simplify<{
  [K in keyof TFields]: InferFieldSelect<TFields[K]>;
}>;

type RequiredInsertKeys<TFields extends Record<string, AnyFieldBuilder>> = {
  [K in keyof TFields]: TFields[K]["__hasDefault"] extends true
    ? never
    : TFields[K]["__nullable"] extends true
      ? never
      : K;
}[keyof TFields];

type OptionalInsertKeys<TFields extends Record<string, AnyFieldBuilder>> = Exclude<
  keyof TFields,
  RequiredInsertKeys<TFields>
>;

export type InferInsertModel<TFields extends Record<string, AnyFieldBuilder>> = Simplify<
  {
    [K in RequiredInsertKeys<TFields>]: InferFieldSelect<TFields[K]>;
  } & {
    [K in OptionalInsertKeys<TFields>]?: InferFieldSelect<TFields[K]>;
  }
>;

export function toSnakeCase(str: string): string {
  return str
    .replace(/([A-Z])/g, (match, p1, offset) => (offset > 0 ? "_" : "") + p1.toLowerCase())
    .toLowerCase();
}

export function defineModel<
  TName extends string,
  TFields extends Record<string, AnyFieldBuilder>,
>(
  name: TName,
  fields: TFields,
  options?: ModelOptions
): ModelDefinition<TName, TFields, Record<string, RelationMeta>> {
  const tableName = options?.tableName ?? \`\${toSnakeCase(name)}s\`;
  const relations: Record<string, RelationMeta> = {};

  if (options?.relations) {
    for (const [relName, relDef] of Object.entries(options.relations)) {
      relations[relName] = { ...relDef, name: relName };
    }
  }

  return {
    name,
    tableName,
    fields,
    relations,
    $InferSelect: {} as InferSelectModel<TFields>,
    $InferInsert: {} as InferInsertModel<TFields>,
  };
}

export const relation = {
  hasOne<TTarget extends AnyModelDefinition>(
    target: () => TTarget,
    opts: { foreignKey: string; references?: string }
  ): Omit<RelationMeta<TTarget, "oneToOne">, "name"> {
    return {
      kind: "oneToOne",
      target: target().name,
      targetModel: target,
      foreignKey: opts.foreignKey,
      references: opts.references ?? "id",
    };
  },
  hasMany<TTarget extends AnyModelDefinition>(
    target: () => TTarget,
    opts: { foreignKey: string; references?: string }
  ): Omit<RelationMeta<TTarget, "oneToMany">, "name"> {
    return {
      kind: "oneToMany",
      target: target().name,
      targetModel: target,
      foreignKey: opts.foreignKey,
      references: opts.references ?? "id",
    };
  },
  belongsTo<TTarget extends AnyModelDefinition>(
    target: () => TTarget,
    opts: { foreignKey: string; references?: string }
  ): Omit<RelationMeta<TTarget, "manyToOne">, "name"> {
    return {
      kind: "manyToOne",
      target: target().name,
      targetModel: target,
      foreignKey: opts.foreignKey,
      references: opts.references ?? "id",
    };
  },
  manyToMany<TTarget extends AnyModelDefinition>(
    target: () => TTarget,
    opts: { joinTable: string; foreignKey?: string; references?: string }
  ): Omit<RelationMeta<TTarget, "manyToMany">, "name"> {
    return {
      kind: "manyToMany",
      target: target().name,
      targetModel: target,
      foreignKey: opts.foreignKey ?? "id",
      references: opts.references ?? "id",
      joinTable: opts.joinTable,
    };
  },
  define<
    TSource extends AnyModelDefinition,
    TRelMap extends Record<string, Omit<RelationMeta<any, any>, "name">>,
  >(
    sourceModel: TSource,
    builder: (helpers: typeof relation) => TRelMap
  ): ModelDefinition<
    TSource["name"],
    TSource["fields"],
    { [K in keyof TRelMap]: TRelMap[K] & { name: K & string } }
  > {
    const built = builder(relation);
    for (const [relName, relDef] of Object.entries(built)) {
      sourceModel.relations[relName] = {
        ...relDef,
        name: relName,
        target: relDef.targetModel ? relDef.targetModel().name : relDef.target,
      };
    }
    return sourceModel as any;
  },
};

export interface SerializedSchemaManifest {
  models: Array<{
    name: string;
    tableName: string;
    fields: FieldMeta[];
    relations: Array<Omit<RelationMeta, "targetModel">>;
  }>;
}

export function serializeSchema(models: AnyModelDefinition[]): SerializedSchemaManifest {
  return {
    models: models.map((m) => ({
      name: m.name,
      tableName: m.tableName,
      fields: Object.entries(m.fields).map(([fieldName, builder]) => ({
        ...builder.meta,
        name: fieldName,
        column: builder.meta.column || toSnakeCase(fieldName),
      })),
      relations: Object.values(m.relations).map((r) => ({
        name: r.name,
        kind: r.kind,
        target: r.targetModel ? r.targetModel().name : r.target,
        foreignKey: r.foreignKey,
        references: r.references,
        joinTable: r.joinTable,
      })),
    })),
  };
}
`,

  "packages/core/src/query/index.ts": `import type { AnyModelDefinition, InferSelectModel } from "../schema/index.js";

export type ComparisonOperator<T> = {
  eq?: T;
  neq?: T;
  gt?: T;
  gte?: T;
  lt?: T;
  lte?: T;
  in?: T[];
  notIn?: T[];
  contains?: string;
  startsWith?: string;
  endsWith?: string;
  isNull?: boolean;
};

export type FieldFilter<T> = T | ComparisonOperator<T>;

export type WhereFilter<TModel extends AnyModelDefinition> = {
  [K in keyof InferSelectModel<TModel["fields"]>]?: FieldFilter<
    InferSelectModel<TModel["fields"]>[K]
  >;
} & {
  AND?: WhereFilter<TModel>[];
  OR?: WhereFilter<TModel>[];
  NOT?: WhereFilter<TModel>;
};

export type OrderDirection = "asc" | "desc";

export type OrderByInput<TModel extends AnyModelDefinition> = {
  [K in keyof InferSelectModel<TModel["fields"]>]?: OrderDirection;
};

export type SelectInput<TModel extends AnyModelDefinition> =
  | Array<keyof InferSelectModel<TModel["fields"]> & string>
  | {
      [K in keyof InferSelectModel<TModel["fields"]>]?: boolean;
    };

export type IncludeOption =
  | boolean
  | {
      where?: Record<string, unknown>;
      select?: string[];
      orderBy?: Record<string, OrderDirection>;
      limit?: number;
      offset?: number;
      include?: Record<string, IncludeOption>;
    };

export type IncludeInput<TModel extends AnyModelDefinition> = {
  [K in keyof TModel["relations"]]?: IncludeOption;
} & Record<string, IncludeOption | undefined>;

export interface FilterASTNode {
  field?: string;
  op?: string;
  value?: unknown;
  AND?: FilterASTNode[];
  OR?: FilterASTNode[];
  NOT?: FilterASTNode;
}

export interface OrderByASTNode {
  field: string;
  dir: OrderDirection;
}

export interface IncludeASTNode {
  where?: FilterASTNode;
  select?: string[];
  orderBy?: OrderByASTNode[];
  limit?: number;
  offset?: number;
  include?: Record<string, IncludeASTNode>;
}

const KNOWN_OPERATORS = new Set([
  "eq",
  "neq",
  "gt",
  "gte",
  "lt",
  "lte",
  "in",
  "notIn",
  "contains",
  "startsWith",
  "endsWith",
  "isNull",
]);

function isOperatorObject(val: unknown): val is Record<string, unknown> {
  if (val === null || typeof val !== "object" || Array.isArray(val) || val instanceof Date) {
    return false;
  }
  const keys = Object.keys(val);
  return keys.length > 0 && keys.every((k) => KNOWN_OPERATORS.has(k));
}

export function normalizeWhereToAST(where?: Record<string, unknown>): FilterASTNode | undefined {
  if (!where || Object.keys(where).length === 0) {
    return undefined;
  }

  const andNodes: FilterASTNode[] = [];

  for (const [key, rawVal] of Object.entries(where)) {
    if (rawVal === undefined) continue;

    if (key === "AND" && Array.isArray(rawVal)) {
      const children = rawVal
        .map((item) => normalizeWhereToAST(item as Record<string, unknown>))
        .filter((n): n is FilterASTNode => Boolean(n));
      if (children.length > 0) {
        andNodes.push({ AND: children });
      }
      continue;
    }

    if (key === "OR" && Array.isArray(rawVal)) {
      const children = rawVal
        .map((item) => normalizeWhereToAST(item as Record<string, unknown>))
        .filter((n): n is FilterASTNode => Boolean(n));
      if (children.length > 0) {
        andNodes.push({ OR: children });
      }
      continue;
    }

    if (key === "NOT" && rawVal && typeof rawVal === "object") {
      const child = normalizeWhereToAST(rawVal as Record<string, unknown>);
      if (child) {
        andNodes.push({ NOT: child });
      }
      continue;
    }

    if (isOperatorObject(rawVal)) {
      for (const [op, opVal] of Object.entries(rawVal)) {
        andNodes.push({
          field: key,
          op,
          value: opVal instanceof Date ? opVal.toISOString() : opVal,
        });
      }
    } else {
      andNodes.push({
        field: key,
        op: "eq",
        value: rawVal instanceof Date ? rawVal.toISOString() : rawVal,
      });
    }
  }

  if (andNodes.length === 0) return undefined;
  if (andNodes.length === 1) return andNodes[0];
  return { AND: andNodes };
}

export function normalizeSelectToAST<TModel extends AnyModelDefinition>(
  select?: SelectInput<TModel>
): string[] | undefined {
  if (!select) return undefined;
  if (Array.isArray(select)) return select;
  const fields = Object.entries(select)
    .filter(([, enabled]) => Boolean(enabled))
    .map(([field]) => field);
  return fields.length > 0 ? fields : undefined;
}

export function normalizeOrderByToAST<TModel extends AnyModelDefinition>(
  orderBy?: OrderByInput<TModel> | Array<OrderByInput<TModel>>
): OrderByASTNode[] | undefined {
  if (!orderBy) return undefined;
  const items = Array.isArray(orderBy) ? orderBy : [orderBy];
  const out: OrderByASTNode[] = [];
  for (const item of items) {
    for (const [field, dir] of Object.entries(item)) {
      if (dir === "asc" || dir === "desc") {
        out.push({ field, dir });
      }
    }
  }
  return out.length > 0 ? out : undefined;
}

export function normalizeIncludeToAST<TModel extends AnyModelDefinition>(
  include?: IncludeInput<TModel>
): Record<string, IncludeASTNode> | undefined {
  if (!include) return undefined;
  const out: Record<string, IncludeASTNode> = {};
  for (const [relName, opt] of Object.entries(include)) {
    if (!opt) continue;
    if (opt === true) {
      out[relName] = {};
    } else if (typeof opt === "object") {
      out[relName] = {
        where: normalizeWhereToAST(opt.where),
        select: opt.select,
        orderBy: normalizeOrderByToAST(opt.orderBy as any),
        limit: opt.limit,
        offset: opt.offset,
        include: normalizeIncludeToAST(opt.include as any),
      };
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}
`,

  "packages/core/src/bridge/engine-bridge.ts": `import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { NexusError, type ProtocolErrorDetail } from "../errors/index.js";

export const PROTOCOL_VERSION = 1;
export const CLIENT_VERSION = "0.1.0";

interface PendingRequest {
  resolve: (value: any) => void;
  reject: (err: NexusError) => void;
  timer: NodeJS.Timeout;
}

export interface BridgeOptions {
  binaryPath?: string;
  defaultTimeoutMs?: number;
  maxRestarts?: number;
  onLog?: (line: string) => void;
}

export class EngineBridge {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private pending = new Map<string, PendingRequest>();
  private reqCounter = 0;
  private shuttingDown = false;
  private restartCount = 0;
  private readonly maxRestarts: number;
  private readonly defaultTimeoutMs: number;
  private readonly binaryPath: string;
  private readonly onLog?: (line: string) => void;
  private lastInitReplay?: () => Promise<void>;

  constructor(opts: BridgeOptions = {}) {
    this.binaryPath = opts.binaryPath ?? EngineBridge.resolveDefaultBinaryPath();
    this.defaultTimeoutMs = opts.defaultTimeoutMs ?? 15_000;
    this.maxRestarts = opts.maxRestarts ?? 3;
    this.onLog = opts.onLog;
  }

  static resolveDefaultBinaryPath(): string {
    const ext = process.platform === "win32" ? ".exe" : "";
    const currentDir = path.dirname(fileURLToPath(import.meta.url));
    const candidates = [
      process.env.NEXUS_ENGINE_PATH,
      path.resolve(process.cwd(), "packages/core/bin/nexus-engine" + ext),
      path.resolve(currentDir, "../../bin/nexus-engine" + ext),
    ].filter((c): c is string => Boolean(c));

    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
    return candidates[0] ?? path.resolve(process.cwd(), "packages/core/bin/nexus-engine" + ext);
  }

  public setReplayHook(hook: () => Promise<void>): void {
    this.lastInitReplay = hook;
  }

  public async start(): Promise<void> {
    if (this.proc) return;
    if (!fs.existsSync(this.binaryPath)) {
      throw new NexusError({
        code: "NEXUS_ENGINE_CRASHED",
        message: \`Nexus Go engine binary not found at \${this.binaryPath}. Run 'npm run build:go' first.\`,
        retryable: false,
      });
    }

    this.shuttingDown = false;
    const child = spawn(this.binaryPath, [], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.proc = child;

    const rlOut = readline.createInterface({ input: child.stdout });
    rlOut.on("line", (line) => this.handleStdoutLine(line));

    const rlErr = readline.createInterface({ input: child.stderr });
    rlErr.on("line", (line) => {
      if (this.onLog) {
        this.onLog(line);
      }
    });

    child.on("exit", (code, signal) => {
      this.proc = null;
      const crashErr = new NexusError({
        code: "NEXUS_ENGINE_CRASHED",
        message: \`Nexus Go engine exited unexpectedly (code=\${code}, signal=\${signal})\`,
        retryable: true,
      });

      for (const [id, pendingReq] of this.pending.entries()) {
        clearTimeout(pendingReq.timer);
        pendingReq.reject(crashErr);
        this.pending.delete(id);
      }

      if (!this.shuttingDown && this.restartCount < this.maxRestarts) {
        this.restartCount++;
        void this.start().then(async () => {
          if (this.lastInitReplay) {
            await this.lastInitReplay();
          }
        });
      }
    });

    const hs = await this.request<{ engineVersion: string; protocolVersion: number }>(
      "engine.handshake",
      {
        clientVersion: CLIENT_VERSION,
        protocolVersion: PROTOCOL_VERSION,
      }
    );

    if (hs.protocolVersion !== PROTOCOL_VERSION) {
      throw new NexusError({
        code: "NEXUS_VERSION_MISMATCH",
        message: \`Protocol version mismatch between Node client (\${PROTOCOL_VERSION}) and Go engine (\${hs.protocolVersion})\`,
        retryable: false,
      });
    }
    this.restartCount = 0;
  }

  private handleStdoutLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let parsed: {
      v: number;
      id: string;
      ok: boolean;
      result?: unknown;
      error?: ProtocolErrorDetail;
    };
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return;
    }

    const pendingReq = this.pending.get(parsed.id);
    if (!pendingReq) return;
    clearTimeout(pendingReq.timer);
    this.pending.delete(parsed.id);

    if (parsed.ok) {
      pendingReq.resolve(parsed.result);
    } else {
      pendingReq.reject(
        NexusError.fromProtocol(
          parsed.error ?? {
            code: "NEXUS_INTERNAL_ERROR",
            message: "Unknown engine error",
            retryable: false,
          }
        )
      );
    }
  }

  public async request<TResult = any>(
    method: string,
    params: unknown = {},
    timeoutMs: number = this.defaultTimeoutMs
  ): Promise<TResult> {
    if (!this.proc && method !== "engine.handshake") {
      await this.start();
    }
    if (!this.proc) {
      throw new NexusError({
        code: "NEXUS_ENGINE_CRASHED",
        message: "Nexus Go engine is not running",
        retryable: true,
      });
    }

    const id = \`req_\${++this.reqCounter}_\${Date.now()}\`;
    const payload =
      JSON.stringify({
        v: PROTOCOL_VERSION,
        id,
        method,
        timeoutMs,
        params,
      }) + "\\n";

    return new Promise<TResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new NexusError({
            code: "NEXUS_TIMEOUT",
            message: \`Engine request '\${method}' timed out after \${timeoutMs}ms\`,
            retryable: true,
          })
        );
      }, timeoutMs);

      this.pending.set(id, { resolve, reject, timer });
      this.proc!.stdin.write(payload, (err) => {
        if (err) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(
            new NexusError({
              code: "NEXUS_ENGINE_CRASHED",
              message: \`Failed writing to Go engine stdin: \${err.message}\`,
              retryable: true,
            })
          );
        }
      });
    });
  }

  public async stop(): Promise<void> {
    this.shuttingDown = true;
    if (!this.proc) return;
    try {
      await this.request("engine.shutdown", {}, 2000);
    } catch {
      // process may already have exited
    } finally {
      if (this.proc) {
        this.proc.kill("SIGTERM");
        this.proc = null;
      }
    }
  }
}
`,

  "packages/core/src/client/index.ts": `import { EngineBridge } from "../bridge/engine-bridge.js";
import type { NexusConfig } from "../config/index.js";
import { NexusError } from "../errors/index.js";
import {
  normalizeIncludeToAST,
  normalizeOrderByToAST,
  normalizeSelectToAST,
  normalizeWhereToAST,
  type IncludeInput,
  type OrderByInput,
  type SelectInput,
  type WhereFilter,
} from "../query/index.js";
import {
  serializeSchema,
  type AnyModelDefinition,
  type InferInsertModel,
  type InferSelectModel,
} from "../schema/index.js";

export interface FindManyArgs<TModel extends AnyModelDefinition> {
  where?: WhereFilter<TModel>;
  select?: SelectInput<TModel>;
  include?: IncludeInput<TModel>;
  orderBy?: OrderByInput<TModel> | Array<OrderByInput<TModel>>;
  limit?: number;
  offset?: number;
}

export interface CreateArgs<TModel extends AnyModelDefinition> {
  data: InferInsertModel<TModel["fields"]> & Record<string, unknown>;
  select?: SelectInput<TModel>;
  include?: IncludeInput<TModel>;
}

export interface CreateManyArgs<TModel extends AnyModelDefinition> {
  data: Array<InferInsertModel<TModel["fields"]>>;
}

export interface UpdateArgs<TModel extends AnyModelDefinition> {
  where: WhereFilter<TModel>;
  data: Partial<InferInsertModel<TModel["fields"]>>;
  select?: SelectInput<TModel>;
  include?: IncludeInput<TModel>;
}

export interface DeleteArgs<TModel extends AnyModelDefinition> {
  where: WhereFilter<TModel>;
}

export class ModelDelegate<TModel extends AnyModelDefinition> {
  constructor(
    private readonly model: TModel,
    private readonly bridge: EngineBridge,
    private readonly ensureConnected: () => Promise<void>,
    private readonly txId?: string
  ) {}

  private async exec(operation: string, payload: Record<string, unknown>) {
    await this.ensureConnected();
    return this.bridge.request("query.execute", {
      txId: this.txId,
      model: this.model.name,
      operation,
      ...payload,
    });
  }

  async findMany(
    args: FindManyArgs<TModel> = {}
  ): Promise<Array<InferSelectModel<TModel["fields"]> & Record<string, any>>> {
    const res = await this.exec("findMany", {
      where: normalizeWhereToAST(args.where as Record<string, unknown>),
      select: normalizeSelectToAST(args.select),
      include: normalizeIncludeToAST(args.include),
      orderBy: normalizeOrderByToAST(args.orderBy),
      limit: args.limit,
      offset: args.offset,
    });
    return res.rows ?? [];
  }

  async findFirst(
    args: FindManyArgs<TModel> = {}
  ): Promise<(InferSelectModel<TModel["fields"]> & Record<string, any>) | null> {
    const res = await this.exec("findFirst", {
      where: normalizeWhereToAST(args.where as Record<string, unknown>),
      select: normalizeSelectToAST(args.select),
      include: normalizeIncludeToAST(args.include),
      orderBy: normalizeOrderByToAST(args.orderBy),
      offset: args.offset,
    });
    return res.row ?? null;
  }

  async findUnique(
    args: FindManyArgs<TModel>
  ): Promise<(InferSelectModel<TModel["fields"]> & Record<string, any>) | null> {
    const res = await this.exec("findUnique", {
      where: normalizeWhereToAST(args.where as Record<string, unknown>),
      select: normalizeSelectToAST(args.select),
      include: normalizeIncludeToAST(args.include),
    });
    return res.row ?? null;
  }

  async create(
    args: CreateArgs<TModel>
  ): Promise<InferSelectModel<TModel["fields"]> & Record<string, any>> {
    const res = await this.exec("create", {
      data: args.data,
      select: normalizeSelectToAST(args.select),
      include: normalizeIncludeToAST(args.include),
    });
    return res.row;
  }

  async createMany(args: CreateManyArgs<TModel>): Promise<{ count: number }> {
    const res = await this.exec("createMany", {
      dataList: args.data,
    });
    return { count: Number(res.count ?? res.affectedRows ?? 0) };
  }

  async update(
    args: UpdateArgs<TModel>
  ): Promise<InferSelectModel<TModel["fields"]> & Record<string, any>> {
    const res = await this.exec("update", {
      where: normalizeWhereToAST(args.where as Record<string, unknown>),
      data: args.data,
      select: normalizeSelectToAST(args.select),
      include: normalizeIncludeToAST(args.include),
    });
    return res.row;
  }

  async updateMany(
    args: UpdateArgs<TModel>
  ): Promise<{ count: number }> {
    const res = await this.exec("updateMany", {
      where: normalizeWhereToAST(args.where as Record<string, unknown>),
      data: args.data,
    });
    return { count: Number(res.count ?? res.affectedRows ?? 0) };
  }

  async delete(
    args: DeleteArgs<TModel>
  ): Promise<InferSelectModel<TModel["fields"]>> {
    const res = await this.exec("delete", {
      where: normalizeWhereToAST(args.where as Record<string, unknown>),
    });
    return res.row;
  }

  async deleteMany(
    args: { where?: WhereFilter<TModel> } = {}
  ): Promise<{ count: number }> {
    const res = await this.exec("deleteMany", {
      where: normalizeWhereToAST(args.where as Record<string, unknown>),
    });
    return { count: Number(res.count ?? res.affectedRows ?? 0) };
  }

  async count(
    args: { where?: WhereFilter<TModel> } = {}
  ): Promise<number> {
    const res = await this.exec("count", {
      where: normalizeWhereToAST(args.where as Record<string, unknown>),
    });
    return Number(res.count ?? 0);
  }

  async exists(where: WhereFilter<TModel>): Promise<boolean> {
    const res = await this.exec("exists", {
      where: normalizeWhereToAST(where as Record<string, unknown>),
    });
    return Boolean(res.exists);
  }
}

export type UncapitalizeModelMap<TModels extends Record<string, AnyModelDefinition>> = {
  [K in keyof TModels as Uncapitalize<TModels[K]["name"]>]: ModelDelegate<TModels[K]>;
};

export interface CreateClientOptions<TModels extends Record<string, AnyModelDefinition>> {
  config: NexusConfig;
  models: TModels;
}

export class BaseNexusClient<TModels extends Record<string, AnyModelDefinition>> {
  public readonly $bridge: EngineBridge;
  public readonly $config: NexusConfig;
  public readonly $models: TModels;
  private isConnected = false;

  constructor(opts: CreateClientOptions<TModels>, existingBridge?: EngineBridge, txId?: string) {
    this.$config = opts.config;
    this.$models = opts.models;
    this.$bridge =
      existingBridge ??
      new EngineBridge({
        binaryPath: opts.config.engineBinaryPath,
      });

    if (!existingBridge) {
      this.$bridge.setReplayHook(async () => {
        this.isConnected = false;
        await this.$connect();
      });
    } else {
      this.isConnected = true;
    }

    for (const model of Object.values(opts.models)) {
      const propName = model.name.charAt(0).toLowerCase() + model.name.slice(1);
      Object.defineProperty(this, propName, {
        value: new ModelDelegate(model, this.$bridge, () => this.$connect(), txId),
        enumerable: true,
        configurable: false,
        writable: false,
      });
    }
  }

  async $connect(): Promise<void> {
    if (this.isConnected) return;
    await this.$bridge.start();
    await this.$bridge.request("engine.connect", {
      dialect: this.$config.dialect,
      url: this.$config.connection.url,
      pool: this.$config.connection.pool,
      logLevel: this.$config.logging.level,
    });
    const manifest = serializeSchema(Object.values(this.$models));
    await this.$bridge.request("schema.register", manifest);
    this.isConnected = true;
  }

  async $pushSchema(): Promise<void> {
    await this.$connect();
    await this.$bridge.request("schema.push", {});
  }

  async $transaction<R>(
    fn: (tx: NexusClient<TModels>) => Promise<R>,
    options: { timeoutMs?: number } = {}
  ): Promise<R> {
    await this.$connect();
    const { txId } = await this.$bridge.request<{ txId: string }>("tx.begin", {
      timeoutMs: options.timeoutMs ?? 15_000,
    });

    const txClient = new BaseNexusClient(
      { config: this.$config, models: this.$models },
      this.$bridge,
      txId
    ) as NexusClient<TModels>;

    try {
      const result = await fn(txClient);
      await this.$bridge.request("tx.commit", { txId });
      return result;
    } catch (err) {
      try {
        await this.$bridge.request("tx.rollback", { txId });
      } catch {
        // ignore rollback error if tx already expired
      }
      if (err instanceof NexusError) throw err;
      throw new NexusError({
        code: "NEXUS_INTERNAL_ERROR",
        message: err instanceof Error ? err.message : String(err),
        retryable: false,
      });
    }
  }

  async $disconnect(): Promise<void> {
    await this.$bridge.stop();
    this.isConnected = false;
  }
}

export type NexusClient<TModels extends Record<string, AnyModelDefinition>> =
  BaseNexusClient<TModels> & UncapitalizeModelMap<TModels>;

export function createClient<TModels extends Record<string, AnyModelDefinition>>(
  opts: CreateClientOptions<TModels>
): NexusClient<TModels> {
  return new BaseNexusClient(opts) as NexusClient<TModels>;
}
`,

  "packages/core/src/index.ts": `export {
  defineConfig,
  loadConfig,
  NexusConfigSchema,
  type NexusConfig,
  type NexusConfigInput,
} from "./config/index.js";

export {
  defineModel,
  field,
  relation,
  serializeSchema,
  toSnakeCase,
  FieldBuilder,
  type AnyFieldBuilder,
  type AnyModelDefinition,
  type FieldDataType,
  type FieldMeta,
  type InferInsertModel,
  type InferSelectModel,
  type ModelDefinition,
  type RelationKind,
  type RelationMeta,
  type SerializedSchemaManifest,
} from "./schema/index.js";

export {
  normalizeIncludeToAST,
  normalizeOrderByToAST,
  normalizeSelectToAST,
  normalizeWhereToAST,
  type ComparisonOperator,
  type FilterASTNode,
  type IncludeInput,
  type OrderByInput,
  type SelectInput,
  type WhereFilter,
} from "./query/index.js";

export {
  createClient,
  BaseNexusClient,
  ModelDelegate,
  type CreateClientOptions,
  type NexusClient,
} from "./client/index.js";

export {
  EngineBridge,
  CLIENT_VERSION,
  PROTOCOL_VERSION,
  type BridgeOptions,
} from "./bridge/engine-bridge.js";

export {
  NexusError,
  scrubCredentials,
  type NexusErrorCode,
  type ProtocolErrorDetail,
} from "./errors/index.js";
`,

  // ============================================================================
  // PHASE 8: CLI PACKAGE (@nexus-orm/cli)
  // ============================================================================
  "packages/cli/bin/nexus.mjs": `#!/usr/bin/env node
import { runCli } from "../dist/index.js";

runCli(process.argv.slice(2)).catch((err) => {
  console.error(\`[Nexus CLI Error] \${err instanceof Error ? err.message : String(err)}\`);
  process.exit(1);
});
`,

  "packages/cli/src/index.ts": `import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { createJiti } from "jiti";
import {
  CLIENT_VERSION,
  EngineBridge,
  NexusError,
  loadConfig,
  serializeSchema,
  type AnyModelDefinition,
  type NexusConfig,
} from "@nexus-orm/core";

async function confirmAction(promptText: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    const answer = await rl.question(\`\${promptText} [y/N]: \`);
    return answer.trim().toLowerCase() === "y" || answer.trim().toLowerCase() === "yes";
  } finally {
    rl.close();
  }
}

async function discoverModels(cwd: string, modelsPath: string): Promise<AnyModelDefinition[]> {
  const fullPath = path.resolve(cwd, modelsPath);
  if (!fs.existsSync(fullPath)) return [];

  const jiti = createJiti(import.meta.url, { interopDefault: true });
  const files: string[] = [];

  const stat = fs.statSync(fullPath);
  if (stat.isDirectory()) {
    for (const entry of fs.readdirSync(fullPath)) {
      if (/\\.(ts|mts|js|mjs)$/.test(entry) && !entry.endsWith(".d.ts")) {
        files.push(path.join(fullPath, entry));
      }
    }
  } else {
    files.push(fullPath);
  }

  const models: AnyModelDefinition[] = [];
  for (const file of files) {
    const mod = (await jiti.import(file)) as Record<string, any>;
    for (const exported of Object.values(mod)) {
      if (
        exported &&
        typeof exported === "object" &&
        typeof exported.name === "string" &&
        typeof exported.tableName === "string" &&
        typeof exported.fields === "object"
      ) {
        models.push(exported as AnyModelDefinition);
      }
    }
  }
  return models;
}

async function createConnectedBridge(config: NexusConfig, models: AnyModelDefinition[]) {
  const bridge = new EngineBridge({ binaryPath: config.engineBinaryPath });
  await bridge.start();
  await bridge.request("engine.connect", {
    dialect: config.dialect,
    url: config.connection.url,
    pool: config.connection.pool,
    logLevel: config.logging.level,
  });
  await bridge.request("schema.register", serializeSchema(models));
  return bridge;
}

export async function runCli(args: string[], cwd: string = process.cwd()): Promise<void> {
  const cmd = args[0] ?? "help";

  switch (cmd) {
    case "version":
    case "--version":
    case "-v": {
      console.log(\`@nexus-orm/cli v\${CLIENT_VERSION}\`);
      console.log(\`@nexus-orm/core v\${CLIENT_VERSION}\`);
      console.log(\`Node.js \${process.version}\`);
      return;
    }

    case "init": {
      const configPath = path.join(cwd, "nexus.config.ts");
      const modelsDir = path.join(cwd, "src/models");
      const migrationsDir = path.join(cwd, "migrations");

      fs.mkdirSync(modelsDir, { recursive: true });
      fs.mkdirSync(migrationsDir, { recursive: true });

      if (!fs.existsSync(configPath)) {
        fs.writeFileSync(
          configPath,
          [
            'import { defineConfig } from "@nexus-orm/core";',
            "",
            "export default defineConfig({",
            '  dialect: "sqlite",',
            "  connection: {",
            '    url: process.env.DATABASE_URL ?? "file:./dev.db",',
            "    pool: { min: 1, max: 5 },",
            "  },",
            '  models: "./src/models",',
            '  migrations: "./migrations",',
            "  logging: { enabled: true, level: \"warn\" },",
            "});",
            "",
          ].join("\\n"),
          "utf8"
        );
      }

      const sampleModelPath = path.join(modelsDir, "user.ts");
      if (!fs.existsSync(sampleModelPath)) {
        fs.writeFileSync(
          sampleModelPath,
          [
            'import { defineModel, field } from "@nexus-orm/core";',
            "",
            'export const User = defineModel("User", {',
            "  id: field.uuid().primaryKey().defaultRandom(),",
            "  username: field.string().unique(),",
            "  email: field.string().unique(),",
            "  active: field.boolean().default(true),",
            "  createdAt: field.date().defaultNow(),",
            "});",
            "",
          ].join("\\n"),
          "utf8"
        );
      }

      console.log("Initialized Nexus project structure:");
      console.log("  - nexus.config.ts");
      console.log("  - src/models/user.ts");
      console.log("  - migrations/");
      return;
    }

    case "generate": {
      const config = await loadConfig(cwd);
      const models = await discoverModels(cwd, config.models);
      const manifest = serializeSchema(models);
      const outDir = path.join(cwd, ".nexus");
      fs.mkdirSync(outDir, { recursive: true });
      const manifestPath = path.join(outDir, "schema-manifest.json");
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
      console.log(\`Generated Nexus schema manifest (\${models.length} models) -> .nexus/schema-manifest.json\`);
      return;
    }

    case "migrate:generate": {
      const config = await loadConfig(cwd);
      const models = await discoverModels(cwd, config.models);
      const nameArg = args[1] ?? "migration";
      const bridge = await createConnectedBridge(config, models);
      try {
        const res = await bridge.request<{ filePath: string }>("migrate.generate", {
          dir: path.resolve(cwd, config.migrations),
          name: nameArg,
        });
        console.log(\`Generated migration file: \${res.filePath}\`);
      } finally {
        await bridge.stop();
      }
      return;
    }

    case "migrate": {
      const config = await loadConfig(cwd);
      const models = await discoverModels(cwd, config.models);
      const bridge = await createConnectedBridge(config, models);
      try {
        const res = await bridge.request<{ applied: string[] }>("migrate.up", {
          dir: path.resolve(cwd, config.migrations),
        });
        if (!res.applied || res.applied.length === 0) {
          console.log("Database is up to date. No pending migrations.");
        } else {
          console.log(\`Applied \${res.applied.length} migration(s):\`);
          for (const m of res.applied) console.log(\`  + \${m}\`);
        }
      } finally {
        await bridge.stop();
      }
      return;
    }

    case "migrate:rollback": {
      const config = await loadConfig(cwd);
      const models = await discoverModels(cwd, config.models);
      const bridge = await createConnectedBridge(config, models);
      try {
        const res = await bridge.request<{ reverted: string }>("migrate.rollback", {
          dir: path.resolve(cwd, config.migrations),
        });
        if (!res.reverted) {
          console.log("No applied migrations to roll back.");
        } else {
          console.log(\`Rolled back migration: \${res.reverted}\`);
        }
      } finally {
        await bridge.stop();
      }
      return;
    }

    case "migrate:status": {
      const config = await loadConfig(cwd);
      const models = await discoverModels(cwd, config.models);
      const bridge = await createConnectedBridge(config, models);
      try {
        const res = await bridge.request<{
          migrations: Array<{ name: string; status: string; appliedAt?: string }>;
        }>("migrate.status", {
          dir: path.resolve(cwd, config.migrations),
        });
        if (!res.migrations || res.migrations.length === 0) {
          console.log("No migration files found.");
        } else {
          for (const m of res.migrations) {
            console.log(\`[\${m.status.toUpperCase()}] \${m.name} \${m.appliedAt ? \`(\${m.appliedAt})\` : ""}\`);
          }
        }
      } finally {
        await bridge.stop();
      }
      return;
    }

    case "migrate:reset": {
      const config = await loadConfig(cwd);
      const isProd = config.env === "production" || process.env.NODE_ENV === "production";
      const forceFlag = args.includes("--force") || args.includes("--yes");

      if (isProd && !args.includes("--force-production")) {
        throw new NexusError({
          code: "NEXUS_VALIDATION_ERROR",
          message:
            "Refusing to run 'nexus migrate:reset' in production environment without --force-production.",
          retryable: false,
        });
      }

      const confirmed =
        forceFlag ||
        (await confirmAction("WARNING: This will roll back and reset all database migrations. Continue?"));
      if (!confirmed) {
        console.log("Migration reset cancelled.");
        return;
      }

      const models = await discoverModels(cwd, config.models);
      const bridge = await createConnectedBridge(config, models);
      try {
        const res = await bridge.request<{ applied: string[] }>("migrate.reset", {
          dir: path.resolve(cwd, config.migrations),
          confirmed: true,
        });
        console.log(\`Database reset complete. Re-applied \${res.applied?.length ?? 0} migration(s).\`);
      } finally {
        await bridge.stop();
      }
      return;
    }

    case "db:push": {
      const config = await loadConfig(cwd);
      const models = await discoverModels(cwd, config.models);
      const bridge = await createConnectedBridge(config, models);
      try {
        await bridge.request("schema.push", {});
        console.log(\`Pushed schema for \${models.length} model(s) directly to database.\`);
      } finally {
        await bridge.stop();
      }
      return;
    }

    case "db:pull": {
      const config = await loadConfig(cwd);
      const bridge = await createConnectedBridge(config, []);
      try {
        const manifest = await bridge.request<{
          models: Array<{
            name: string;
            tableName: string;
            fields: Array<{ name: string; type: string; primaryKey: boolean; unique: boolean; nullable: boolean }>;
          }>;
        }>("schema.introspect", {});

        const lines: string[] = ['import { defineModel, field } from "@nexus-orm/core";', ""];
        for (const m of manifest.models ?? []) {
          lines.push(\`export const \${m.name} = defineModel("\${m.name}", {\`);
          for (const f of m.fields) {
            let chain = \`field.\${f.type}()\`;
            if (f.primaryKey) chain += ".primaryKey()";
            if (f.unique) chain += ".unique()";
            if (f.nullable) chain += ".nullable()";
            lines.push(\`  \${f.name}: \${chain},\`);
          }
          lines.push("});", "");
        }

        const outFile = path.resolve(cwd, config.models, "introspected.ts");
        fs.mkdirSync(path.dirname(outFile), { recursive: true });
        fs.writeFileSync(outFile, lines.join("\\n"), "utf8");
        console.log(\`Introspected \${manifest.models?.length ?? 0} model(s) -> \${outFile}\`);
      } finally {
        await bridge.stop();
      }
      return;
    }

    case "studio": {
      const config = await loadConfig(cwd);
      const models = await discoverModels(cwd, config.models);
      const bridge = await createConnectedBridge(config, models);
      const res = await bridge.request<{ url: string }>("studio.start", { port: 4983 });
      console.log(\`Nexus Studio is running at \${res.url} (Press Ctrl+C to stop)\`);
      return;
    }

    default: {
      console.log("Nexus ORM CLI");
      console.log("Commands:");
      console.log("  nexus init               Initialize nexus.config.ts and directories");
      console.log("  nexus generate           Validate models and emit schema manifest");
      console.log("  nexus migrate            Apply pending database migrations");
      console.log("  nexus migrate:rollback   Roll back the last applied migration");
      console.log("  nexus migrate:status     Show applied, pending, and conflicting migrations");
      console.log("  nexus migrate:generate   Generate a new Up/Down SQL migration from models");
      console.log("  nexus migrate:reset      Reset and re-apply all migrations (requires confirmation)");
      console.log("  nexus db:push            Push model schema directly to the database");
      console.log("  nexus db:pull            Introspect existing database into TypeScript models");
      console.log("  nexus studio             Launch local Nexus Studio data browser");
      console.log("  nexus version            Display Nexus CLI and Core versions");
    }
  }
}
`,

  // ============================================================================
  // PHASE 9 (VITEST SUITE): UNIT + FULL END-TO-END TS <-> GO IPC TESTS
  // ============================================================================
  "packages/core/tests/nexus.test.ts": `import fs from "node:fs";
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
`,

  // ============================================================================
  // PHASE 10: DOCUMENTATION (README.md)
  // ============================================================================
  "README.md": `# Project Nexus ORM

Nexus is a Go-powered ORM and database management toolkit with a TypeScript-first developer experience for Node.js applications.

## Architecture

- **TypeScript Layer (\`@nexus-orm/core\`, \`@nexus-orm/cli\`)**: Provides \`defineConfig()\`, \`defineModel()\`, \`field.*\`, \`relation.define()\`, static \`$InferSelect\` / \`$InferInsert\` type inference, query AST construction, and the CLI.
- **Go Execution Engine (\`engine/cmd/nexus-engine\`)**: Persistent child process communicating with Node.js via multiplexed Newline-Delimited JSON-RPC (NDJSON-RPC) over \`stdin\`/\`stdout\` with structured \`stderr\` logging, powered by a pluggable GORM backend supporting PostgreSQL, SQLite, and MySQL.

## Quickstart

\`\`\`bash
# 1. Install TypeScript workspace dependencies
npm install

# 2. Fetch Go module dependencies & compile the Go engine + TypeScript packages
cd engine && go mod tidy && cd ..
npm run build

# 3. Run both Go and TypeScript (Vitest) test suites
npm test
\`\`\`

## Defining Configuration (\`nexus.config.ts\`)

\`\`\`ts
import { defineConfig } from "@nexus-orm/core";

export default defineConfig({
  dialect: "postgres",
  connection: {
    url: process.env.DATABASE_URL!,
    pool: { min: 2, max: 10 },
  },
  models: "./src/models",
  migrations: "./migrations",
  logging: { enabled: true, level: "warn" },
});
\`\`\`

## Defining Models & Relations

\`\`\`ts
import { defineModel, field, relation } from "@nexus-orm/core";

export const User = defineModel("User", {
  id: field.uuid().primaryKey().defaultRandom(),
  username: field.string().unique(),
  email: field.string().unique(),
  active: field.boolean().default(true),
  createdAt: field.date().defaultNow(),
});

export const Post = defineModel("Post", {
  id: field.uuid().primaryKey().defaultRandom(),
  title: field.string(),
  authorId: field.uuid().references(() => User, "id", { onDelete: "CASCADE" }),
});

relation.define(User, ({ hasMany }) => ({
  posts: hasMany(() => Post, { foreignKey: "authorId" }),
}));
\`\`\`

## Querying

\`\`\`ts
import { createClient } from "@nexus-orm/core";
import config from "./nexus.config.js";
import { User, Post } from "./src/models/index.js";

const db = createClient({ config, models: { User, Post } });

const activeUsers = await db.user.findMany({
  where: { active: true },
  include: { posts: true },
  orderBy: { createdAt: "desc" },
  limit: 20,
});
\`\`\`

## CLI Commands

- \`nexus init\` — Scaffold \`nexus.config.ts\`, \`src/models/\`, and \`migrations/\`
- \`nexus generate\` — Validate models and emit \`.nexus/schema-manifest.json\`
- \`nexus migrate:generate <name>\` — Generate a timestamped Up/Down SQL migration file
- \`nexus migrate\` — Apply pending migrations with SHA-256 checksum validation
- \`nexus migrate:rollback\` — Revert the most recent migration
- \`nexus migrate:status\` — List applied, pending, and conflicting migrations
- \`nexus migrate:reset\` — Roll back and re-apply all migrations (protected by confirmation prompt)
- \`nexus db:push\` — Push model schema directly to the database
- \`nexus db:pull\` — Introspect an existing database into TypeScript models
- \`nexus studio\` — Launch the local Nexus Studio web server
- \`nexus version\` — Print CLI, Core, and runtime versions
`,
};

console.log("=== Project Nexus: Writing Phases 2 through 10 ===");

for (const [relativePath, content] of Object.entries(files)) {
  const fullPath = path.join(ROOT, relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content, "utf8");
  if (relativePath.endsWith(".mjs")) {
    try {
      fs.chmodSync(fullPath, 0o755);
    } catch {
      // Ignore chmod on Windows
    }
  }
  console.log(`[WROTE] ${relativePath}`);
}

console.log("\\nAll Project Nexus files (Phases 2-10) have been written.");
console.log("Next steps:");
console.log("  1. npm install");
console.log("  2. cd engine && go mod tidy && cd ..");
console.log("  3. npm run build");
console.log("  4. npm test");
