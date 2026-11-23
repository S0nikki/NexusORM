package protocol

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
	Version   int             `json:"v"`
	ID        string          `json:"id"`
	Method    string          `json:"method"`
	TimeoutMs int             `json:"timeoutMs,omitempty"`
	Params    json.RawMessage `json:"params,omitempty"`
}

type Response struct {
	Version int          `json:"v"`
	ID      string       `json:"id"`
	OK      bool         `json:"ok"`
	Result  any          `json:"result,omitempty"`
	Error   *ErrorDetail `json:"error,omitempty"`
}

type ErrorDetail struct {
	Code      string   `json:"code"`
	Message   string   `json:"message"`
	Model     string   `json:"model,omitempty"`
	Fields    []string `json:"fields,omitempty"`
	Retryable bool     `json:"retryable"`
}

type HandshakeRequest struct {
	ClientVersion   string `json:"clientVersion"`
	ProtocolVersion int    `json:"protocolVersion"`
}

type HandshakeResponse struct {
	EngineVersion   string `json:"engineVersion"`
	ProtocolVersion int    `json:"protocolVersion"`
}

type PoolConfig struct {
	Min           int `json:"min"`
	Max           int `json:"max"`
	IdleTimeoutMs int `json:"idleTimeoutMs,omitempty"`
}

type ConnectionConfig struct {
	Dialect  string     `json:"dialect"`
	URL      string     `json:"url"`
	Pool     PoolConfig `json:"pool"`
	LogLevel string     `json:"logLevel"`
}

type ReferenceSchema struct {
	Model    string `json:"model"`
	Column   string `json:"column"`
	OnDelete string `json:"onDelete,omitempty"`
}

type FieldSchema struct {
	Name          string           `json:"name"`
	Column        string           `json:"column"`
	Type          string           `json:"type"`
	PrimaryKey    bool             `json:"primaryKey"`
	Unique        bool             `json:"unique"`
	Nullable      bool             `json:"nullable"`
	Index         bool             `json:"index"`
	AutoIncrement bool             `json:"autoIncrement"`
	MaxLength     int              `json:"maxLength,omitempty"`
	DefaultKind   string           `json:"defaultKind,omitempty"` // "none" | "static" | "now" | "uuid"
	DefaultValue  any              `json:"defaultValue,omitempty"`
	References    *ReferenceSchema `json:"references,omitempty"`
}

type RelationSchema struct {
	Name       string `json:"name"`
	Kind       string `json:"kind"` // "oneToOne" | "oneToMany" | "manyToOne" | "manyToMany"
	Target     string `json:"target"`
	ForeignKey string `json:"foreignKey"`
	References string `json:"references"`
	JoinTable  string `json:"joinTable,omitempty"`
}

type ModelSchema struct {
	Name      string           `json:"name"`
	TableName string           `json:"tableName"`
	Fields    []FieldSchema    `json:"fields"`
	Relations []RelationSchema `json:"relations,omitempty"`
}

type SchemaManifest struct {
	Models []ModelSchema `json:"models"`
}

type FilterNode struct {
	Field string       `json:"field,omitempty"`
	Op    string       `json:"op,omitempty"`
	Value any          `json:"value,omitempty"`
	AND   []FilterNode `json:"AND,omitempty"`
	OR    []FilterNode `json:"OR,omitempty"`
	NOT   *FilterNode  `json:"NOT,omitempty"`
}

type OrderByNode struct {
	Field string `json:"field"`
	Dir   string `json:"dir"` // "asc" | "desc"
}

type IncludeNode struct {
	Where   *FilterNode            `json:"where,omitempty"`
	Select  []string               `json:"select,omitempty"`
	OrderBy []OrderByNode          `json:"orderBy,omitempty"`
	Limit   int                    `json:"limit,omitempty"`
	Offset  int                    `json:"offset,omitempty"`
	Include map[string]IncludeNode `json:"include,omitempty"`
}

type QueryAST struct {
	TxID      string                 `json:"txId,omitempty"`
	Model     string                 `json:"model"`
	Operation string                 `json:"operation"`
	Where     *FilterNode            `json:"where,omitempty"`
	Data      map[string]any         `json:"data,omitempty"`
	DataList  []map[string]any       `json:"dataList,omitempty"`
	Select    []string               `json:"select,omitempty"`
	Include   map[string]IncludeNode `json:"include,omitempty"`
	OrderBy   []OrderByNode          `json:"orderBy,omitempty"`
	Limit     int                    `json:"limit,omitempty"`
	Offset    int                    `json:"offset,omitempty"`
}

type QueryResult struct {
	Rows         []map[string]any `json:"rows"`
	Row          map[string]any   `json:"row,omitempty"`
	AffectedRows int64            `json:"affectedRows"`
	Count        int64            `json:"count"`
	Exists       bool             `json:"exists"`
}

type TxOptions struct {
	TimeoutMs int `json:"timeoutMs,omitempty"`
}

var (
	urlCredRegex = regexp.MustCompile(`([a-zA-Z0-9+.-]+://[^:/\s]+:)([^@\s]+)(@)`)
	kvPassRegex  = regexp.MustCompile(`(?i)(password|passwd|pwd|secret)=([^\s&;]+)`)
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
