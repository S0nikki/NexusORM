package registry

import (
	"fmt"
	"reflect"
	"regexp"
	"strings"
	"sync"
	"time"

	"nexus/engine/internal/protocol"
)

var validIdentifier = regexp.MustCompile(`^[a-zA-Z_][a-zA-Z0-9_]*$`)

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
				Tag:  reflect.StructTag(fmt.Sprintf(`gorm:"%s" json:"%s"`, gormTag, f.Name)),
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
