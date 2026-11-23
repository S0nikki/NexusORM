package protocol

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
