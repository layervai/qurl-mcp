package gateway

import (
	"os"
	"path/filepath"
	"testing"
)

func TestLoadConfigResolvesDeploymentPathRelativeToConfig(t *testing.T) {
	dir := t.TempDir()
	configPath := filepath.Join(dir, "gateway.json")
	if err := os.WriteFile(configPath, []byte(`{
  "apiBaseUrl":"https://api.example.test",
  "apiKey":"test-key",
  "deploymentPath":"trust/deployment.json"
}`), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("QURL_CONNECTOR_CONFIG", configPath)
	config, err := LoadConfig()
	if err != nil {
		t.Fatal(err)
	}
	want := filepath.Join(dir, "trust", "deployment.json")
	if config.DeploymentPath != want {
		t.Fatalf("DeploymentPath = %q, want %q", config.DeploymentPath, want)
	}
}
