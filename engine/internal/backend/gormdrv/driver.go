package gormdrv

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
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
	db             *gorm.DB
	dialect        string
	registry       *registry.Registry
	txMgr          *tx.Manager
	tempSqlitePath string
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
		dsn := cfg.URL
		if dsn == "" || dsn == ":memory:" || strings.Contains(dsn, ":memory:") {
			tmpPath := filepath.Join(os.TempDir(), fmt.Sprintf("nexus_mem_%s.db", uuid.NewString()))
			d.tempSqlitePath = tmpPath
			dsn = tmpPath
		} else {
			dsn = strings.TrimPrefix(dsn, "file:")
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
		if d.tempSqlitePath != "" {
			db.Exec("PRAGMA journal_mode = MEMORY;")
			db.Exec("PRAGMA synchronous = OFF;")
		}
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
	if d.db != nil {
		sqlDB, err := d.db.DB()
		if err == nil {
			_ = sqlDB.Close()
		}
	}
	if d.tempSqlitePath != "" {
		_ = os.Remove(d.tempSqlitePath)
		d.tempSqlitePath = ""
	}
	return nil
}

func (d *GormDriver) resolveSession(ctx context.Context, txID string) (*gorm.DB, error) {
	if txID == "" {
		return d.db.WithContext(ctx), nil
	}
	txDB, err := d.txMgr.Get(txID)
	if err != nil {
		return nil, err
	}
	return txDB, nil
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
	txSession := session.Table(model.Schema.TableName)

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
	txSession = txSession.Select(cols)

	whereSQL, whereArgs, err := query.CompileFilter(model, ast.Where)
	if err != nil {
		return nil, err
	}
	if whereSQL != "" {
		txSession = txSession.Where(whereSQL, whereArgs...)
	}

	orderSQL, err := query.CompileOrderBy(model, ast.OrderBy)
	if err != nil {
		return nil, err
	}
	if orderSQL != "" {
		txSession = txSession.Order(orderSQL)
	}

	if ast.Limit > 0 {
		txSession = txSession.Limit(ast.Limit)
	}
	if ast.Offset > 0 {
		txSession = txSession.Offset(ast.Offset)
	}

	var rawRows []map[string]any
	if err := txSession.Find(&rawRows).Error; err != nil {
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

func (d *GormDriver) execCreateMany(_ context.Context, session *gorm.DB, model *registry.RegisteredModel, ast protocol.QueryAST) (int64, error) {
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
	txSession := session.Table(model.Schema.TableName)
	if whereSQL != "" {
		txSession = txSession.Where(whereSQL, whereArgs...)
	}
	if err := txSession.Updates(updateCols).Error; err != nil {
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

func (d *GormDriver) execUpdateMany(_ context.Context, session *gorm.DB, model *registry.RegisteredModel, ast protocol.QueryAST) (int64, error) {
	updateCols, err := prepareUpdateMap(model, ast.Data)
	if err != nil {
		return 0, err
	}
	whereSQL, whereArgs, err := query.CompileFilter(model, ast.Where)
	if err != nil {
		return 0, err
	}
	txSession := session.Table(model.Schema.TableName)
	if whereSQL != "" {
		txSession = txSession.Where(whereSQL, whereArgs...)
	} else {
		txSession = txSession.Where("1 = 1")
	}
	res := txSession.Updates(updateCols)
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
	txSession := session.Table(model.Schema.TableName)
	if whereSQL != "" {
		txSession = txSession.Where(whereSQL, whereArgs...)
	}
	if err := txSession.Delete(map[string]any{}).Error; err != nil {
		return nil, err
	}
	return existing[0], nil
}

func (d *GormDriver) execDeleteMany(_ context.Context, session *gorm.DB, model *registry.RegisteredModel, ast protocol.QueryAST) (int64, error) {
	whereSQL, whereArgs, err := query.CompileFilter(model, ast.Where)
	if err != nil {
		return 0, err
	}
	txSession := session.Table(model.Schema.TableName)
	if whereSQL != "" {
		txSession = txSession.Where(whereSQL, whereArgs...)
	} else {
		txSession = txSession.Where("1 = 1")
	}
	res := txSession.Delete(map[string]any{})
	return res.RowsAffected, res.Error
}

func (d *GormDriver) execCount(session *gorm.DB, model *registry.RegisteredModel, ast protocol.QueryAST) (int64, error) {
	whereSQL, whereArgs, err := query.CompileFilter(model, ast.Where)
	if err != nil {
		return 0, err
	}
	txSession := session.Table(model.Schema.TableName)
	if whereSQL != "" {
		txSession = txSession.Where(whereSQL, whereArgs...)
	}
	var count int64
	if err := txSession.Count(&count).Error; err != nil {
		return 0, err
	}
	return count, nil
}

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
			if err := session.Table(rel.JoinTable).Where("\""+leftCol+"\" IN ?", parentIDs).Find(&joinRows).Error; err != nil {
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
		colDef := "\"" + f.Column + "\" " + mapSQLType(dialect, f)
		if f.PrimaryKey {
			if f.AutoIncrement && dialect == "sqlite" {
				colDef = "\"" + f.Column + "\" INTEGER PRIMARY KEY AUTOINCREMENT"
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
			colDef += fmt.Sprintf(" REFERENCES %q(%q) ON DELETE %s", refTable, refCol, onDelete)
		}
		cols = append(cols, colDef)
	}
	return fmt.Sprintf("CREATE TABLE IF NOT EXISTS %q (%s);", m.TableName, strings.Join(cols, ", "))
}

func BuildIndexSQL(m protocol.ModelSchema) []string {
	var stmts []string
	for _, f := range m.Fields {
		if f.Index && !f.Unique && !f.PrimaryKey {
			idxName := fmt.Sprintf("idx_%s_%s", m.TableName, f.Column)
			stmts = append(stmts, fmt.Sprintf("CREATE INDEX IF NOT EXISTS %q ON %q (%q);", idxName, m.TableName, f.Column))
		}
	}
	return stmts
}

func BuildJoinTableSQL(joinTable string, left, right protocol.ModelSchema) string {
	leftCol := registry.ToSnakeCase(left.Name) + "_id"
	rightCol := registry.ToSnakeCase(right.Name) + "_id"
	return fmt.Sprintf(
		"CREATE TABLE IF NOT EXISTS %q (%q TEXT NOT NULL, %q TEXT NOT NULL, PRIMARY KEY (%q, %q));",
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
