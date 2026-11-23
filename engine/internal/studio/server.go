package studio

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
