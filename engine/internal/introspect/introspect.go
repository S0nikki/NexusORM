package introspect

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
