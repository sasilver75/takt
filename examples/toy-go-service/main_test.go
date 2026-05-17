package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestHealth(t *testing.T) {
	health := Health()
	if health.Status != "ok" {
		t.Fatalf("status = %q, want ok", health.Status)
	}
	if !health.Dependencies["http"] {
		t.Fatalf("expected http dependency to be healthy")
	}
}

func TestHealthEndpoint(t *testing.T) {
	request := httptest.NewRequest(http.MethodGet, "/healthz", nil)
	response := httptest.NewRecorder()

	NewServer().ServeHTTP(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("status code = %d, want %d", response.Code, http.StatusOK)
	}
	body := response.Body.String()
	if !strings.Contains(body, `"service":"toy-go-service"`) {
		t.Fatalf("body = %q, want service name", body)
	}
}
