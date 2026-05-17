package main

import (
	"encoding/json"
	"log"
	"net/http"
	"os"
)

type HealthResponse struct {
	Status       string          `json:"status"`
	Service      string          `json:"service"`
	Dependencies map[string]bool `json:"dependencies"`
}

func Health() HealthResponse {
	return HealthResponse{
		Status:       "ok",
		Service:      "toy-go-service",
		Dependencies: map[string]bool{"http": true},
	}
}

func NewServer() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", handleHealth)
	return mux
}

func handleHealth(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, Health())
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("content-type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(body); err != nil {
		log.Printf("write response: %v", err)
	}
}

func main() {
	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}
	log.Printf("toy-go-service listening on http://127.0.0.1:%s", port)
	log.Fatal(http.ListenAndServe(":"+port, NewServer()))
}
