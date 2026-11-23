package backend

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
