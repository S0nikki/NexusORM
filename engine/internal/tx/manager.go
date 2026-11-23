package tx

import (
	"context"
	"fmt"
	"sync"
	"time"

	"github.com/google/uuid"
	"gorm.io/gorm"
)

type entry struct {
	db        *gorm.DB
	cancel    context.CancelFunc
	expiresAt time.Time
}

type Manager struct {
	mu       sync.RWMutex
	sessions map[string]*entry
	stopCh   chan struct{}
}

func NewManager() *Manager {
	m := &Manager{
		sessions: make(map[string]*entry),
		stopCh:   make(chan struct{}),
	}
	go m.watchdog()
	return m
}

func (m *Manager) Begin(_ context.Context, rootDB *gorm.DB, timeoutMs int) (string, error) {
	if timeoutMs <= 0 {
		timeoutMs = 15000
	}
	txCtx, cancel := context.WithTimeout(
		context.Background(),
		time.Duration(timeoutMs)*time.Millisecond,
	)
	txDB := rootDB.WithContext(txCtx).Begin()
	if txDB.Error != nil {
		cancel()
		return "", txDB.Error
	}
	id := "tx_" + uuid.NewString()
	m.mu.Lock()
	m.sessions[id] = &entry{
		db:        txDB,
		cancel:    cancel,
		expiresAt: time.Now().Add(time.Duration(timeoutMs) * time.Millisecond),
	}
	m.mu.Unlock()
	return id, nil
}

func (m *Manager) Get(txID string) (*gorm.DB, error) {
	m.mu.RLock()
	e, ok := m.sessions[txID]
	m.mu.RUnlock()
	if !ok {
		return nil, fmt.Errorf("transaction %s not found or expired", txID)
	}
	if time.Now().After(e.expiresAt) {
		_ = m.Rollback(txID)
		return nil, fmt.Errorf("transaction %s timed out", txID)
	}
	return e.db, nil
}

func (m *Manager) Commit(txID string) error {
	m.mu.Lock()
	e, ok := m.sessions[txID]
	if ok {
		delete(m.sessions, txID)
	}
	m.mu.Unlock()
	if !ok {
		return fmt.Errorf("transaction %s not found or already closed", txID)
	}
	defer e.cancel()
	return e.db.Commit().Error
}

func (m *Manager) Rollback(txID string) error {
	m.mu.Lock()
	e, ok := m.sessions[txID]
	if ok {
		delete(m.sessions, txID)
	}
	m.mu.Unlock()
	if !ok {
		return fmt.Errorf("transaction %s not found or already closed", txID)
	}
	defer e.cancel()
	return e.db.Rollback().Error
}

func (m *Manager) watchdog() {
	ticker := time.NewTicker(1 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-m.stopCh:
			return
		case now := <-ticker.C:
			m.mu.Lock()
			for id, e := range m.sessions {
				if now.After(e.expiresAt) {
					_ = e.db.Rollback()
					e.cancel()
					delete(m.sessions, id)
				}
			}
			m.mu.Unlock()
		}
	}
}

func (m *Manager) CloseAll() {
	close(m.stopCh)
	m.mu.Lock()
	defer m.mu.Unlock()
	for id, e := range m.sessions {
		_ = e.db.Rollback()
		e.cancel()
		delete(m.sessions, id)
	}
}
