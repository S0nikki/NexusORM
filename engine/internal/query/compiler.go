package query

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
		quotedCol := `"` + col + `"`
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
			cols = append(cols, `"`+f.Column+`"`)
		}
		return cols, nil
	}
	cols := make([]string, 0, len(selectFields))
	for _, fieldName := range selectFields {
		col, ok := model.ColsByField[fieldName]
		if !ok {
			return nil, fmt.Errorf("unknown select field %q on model %q", fieldName, model.Schema.Name)
		}
		cols = append(cols, `"`+col+`"`)
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
		parts = append(parts, `"`+col+`" `+dir)
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
