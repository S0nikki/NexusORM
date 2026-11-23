package main

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
		fmt.Fprintf(os.Stderr, `{"level":"error","msg":"marshal failure: %v"}`+"\n", err)
		return
	}
	_, _ = os.Stdout.Write(append(bytes, '\n'))
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
			TxID string `json:"txId"`
		}
		_ = json.Unmarshal(req.Params, &payload)
		if err := e.driver.CommitTx(ctx, payload.TxID); err != nil {
			e.send(protocol.NewErrorResponse(req.ID, protocol.ErrTxExpired, err.Error(), "", nil, false))
			return
		}
		e.send(protocol.NewSuccessResponse(req.ID, map[string]any{"committed": true}))

	case "tx.rollback":
		var payload struct {
			TxID string `json:"txId"`
		}
		_ = json.Unmarshal(req.Params, &payload)
		if err := e.driver.RollbackTx(ctx, payload.TxID); err != nil {
			e.send(protocol.NewErrorResponse(req.ID, protocol.ErrTxExpired, err.Error(), "", nil, false))
			return
		}
		e.send(protocol.NewSuccessResponse(req.ID, map[string]any{"rolledBack": true}))

	case "migrate.generate":
		var payload struct {
			Dir  string `json:"dir"`
			Name string `json:"name"`
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
			Dir string `json:"dir"`
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
			Dir string `json:"dir"`
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
			Dir string `json:"dir"`
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
			Dir       string `json:"dir"`
			Confirmed bool   `json:"confirmed"`
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
			Port int `json:"port"`
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
