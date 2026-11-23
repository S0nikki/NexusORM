package migrator

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
	ID              string `json:"id"`
	Name            string `json:"name"`
	Checksum        string `json:"checksum"`
	AppliedAt       string `json:"appliedAt"`
	ExecutionTimeMs int64  `json:"executionTimeMs"`
}

type MigrationStatus struct {
	Name      string `json:"name"`
	Status    string `json:"status"` // "applied" | "pending" | "conflict"
	Checksum  string `json:"checksum"`
	AppliedAt string `json:"appliedAt,omitempty"`
}

type Migrator struct {
	driver *gormdrv.GormDriver
}

func NewMigrator(driver *gormdrv.GormDriver) *Migrator {
	return &Migrator{driver: driver}
}

func (m *Migrator) EnsureHistoryTable(ctx context.Context) error {
	ddl := fmt.Sprintf(`CREATE TABLE IF NOT EXISTS "%s" (
		"id" TEXT PRIMARY KEY,
		"name" TEXT NOT NULL UNIQUE,
		"checksum" TEXT NOT NULL,
		"applied_at" TEXT NOT NULL,
		"execution_time_ms" INTEGER NOT NULL
	);`, HistoryTable)
	return m.driver.DB().WithContext(ctx).Exec(ddl).Error
}

func ComputeChecksum(content string) string {
	Normalized := strings.ReplaceAll(content, "\r\n", "\n")
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
					downStmts = append([]string{fmt.Sprintf(`DROP TABLE IF EXISTS "%s";`, rel.JoinTable)}, downStmts...)
				}
			}
		}
		downStmts = append([]string{fmt.Sprintf(`DROP TABLE IF EXISTS "%s";`, model.Schema.TableName)}, downStmts...)
	}

	timestamp := time.Now().UTC().Format("20060102150405")
	safeName := strings.ReplaceAll(strings.ToLower(strings.TrimSpace(migrationName)), " ", "_")
	if safeName == "" {
		safeName = "schema_sync"
	}
	fileName := fmt.Sprintf("%s_%s.sql", timestamp, safeName)
	fullPath := filepath.Join(migrationsDir, fileName)

	var content strings.Builder
	content.WriteString("-- +nexus Up\n")
	for _, stmt := range upStmts {
		content.WriteString(stmt + "\n")
	}
	content.WriteString("\n-- +nexus Down\n")
	for _, stmt := range downStmts {
		content.WriteString(stmt + "\n")
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
		return tx.Table(HistoryTable).Where(`"name" = ?`, last.Name).Delete(map[string]any{}).Error
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
	err := m.driver.DB().WithContext(ctx).Table(HistoryTable).Order(`"name" ASC`).Find(&rows).Error
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
