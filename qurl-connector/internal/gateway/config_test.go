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

func TestConfigFromFileDynamicCRIDDefaultsOn(t *testing.T) {
	base := fileConfig{APIBaseURL: "https://api.example.test", APIKey: "test-key"}
	config, err := configFromFile(base)
	if err != nil || !config.DynamicCRID {
		t.Fatalf("DynamicCRID = %t, err = %v; want enabled by default", config.DynamicCRID, err)
	}
	disabled := false
	base.DynamicCRID = &disabled
	config, err = configFromFile(base)
	if err != nil || config.DynamicCRID {
		t.Fatalf("DynamicCRID = %t, err = %v; want disabled", config.DynamicCRID, err)
	}
}
