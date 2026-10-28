package gateway

import (
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"
)

// Config contains the settings needed by the CLI-facing gateway. Share is an
// authenticated API operation, so APIKey must be a qURL credential with share
// permission. It may be an account key or a registered device key.
type Config struct {
	ListenAddr       string
	APIBaseURL       string
	APIKey           string
	DeploymentPath   string
	AllowedLinkHosts map[string]struct{}
	CRIDHeader       string
	// DynamicCRID lets clients initialize without a CRID and pass it as an
	// argument of the connector's qurl_list_tools, qurl_call_tool, and
	// qurl_get_link tools.
	DynamicCRID bool
}

type fileConfig struct {
	ListenAddr       string   `json:"listenAddr"`
	APIBaseURL       string   `json:"apiBaseUrl"`
	APIKey           string   `json:"apiKey"`
	DeploymentPath   string   `json:"deploymentPath"`
	AllowedLinkHosts []string `json:"allowedLinkHosts"`
	CRIDHeader       string   `json:"cridHeader"`
	DynamicCRID      *bool    `json:"dynamicCrid"`
}

// LoadConfig reads the configured JSON file, or the local default file.
func LoadConfig() (Config, error) {
	path := strings.TrimSpace(os.Getenv("QURL_CONNECTOR_CONFIG"))
	if path == "" {
		// Compatibility for existing deployments during the rename.
		path = strings.TrimSpace(os.Getenv("QURL_CLI_MCP_GATEWAY_CONFIG"))
	}
	if path == "" {
		path = "qurl-connector.json"
	}
	contents, err := os.ReadFile(path)
	if err != nil {
		return Config{}, fmt.Errorf("read gateway config %s: %w", path, err)
	}
	var file fileConfig
	if err := json.Unmarshal(contents, &file); err != nil {
		return Config{}, fmt.Errorf("parse gateway config %s: %w", path, err)
	}
	config, err := configFromFile(file)
	if err != nil {
		return Config{}, err
	}
	deploymentPath := strings.TrimSpace(file.DeploymentPath)
	if deploymentPath == "" {
		deploymentPath = strings.TrimSpace(os.Getenv(qurlDeploymentEnv))
	}
	if deploymentPath != "" && !filepath.IsAbs(deploymentPath) {
		deploymentPath = filepath.Join(filepath.Dir(path), deploymentPath)
	}
	config.DeploymentPath = deploymentPath
	return config, nil
}

func configFromFile(file fileConfig) (Config, error) {
	listenAddr := strings.TrimSpace(file.ListenAddr)
	if listenAddr == "" {
		listenAddr = "127.0.0.1:3100"
	}
	apiBaseURL := strings.TrimRight(strings.TrimSpace(file.APIBaseURL), "/")
	if apiBaseURL == "" {
		return Config{}, fmt.Errorf("apiBaseUrl is required")
	}
	parsed, err := url.Parse(apiBaseURL)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" || parsed.Path != "" {
		return Config{}, fmt.Errorf("apiBaseUrl must be an origin URL")
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return Config{}, fmt.Errorf("apiBaseUrl must use http or https")
	}
	apiKey := strings.TrimSpace(file.APIKey)
	if apiKey == "" {
		return Config{}, fmt.Errorf("apiKey is required")
	}
	cridHeader := strings.TrimSpace(file.CRIDHeader)
	if cridHeader == "" {
		cridHeader = "X-MCP-CRID"
	}
	hosts := make(map[string]struct{}, len(file.AllowedLinkHosts))
	for _, value := range file.AllowedLinkHosts {
		if host := strings.ToLower(strings.TrimSpace(value)); host != "" {
			hosts[host] = struct{}{}
		}
	}
	if len(hosts) == 0 {
		hosts["qurl.link"] = struct{}{}
	}
	dynamicCRID := true
	if file.DynamicCRID != nil {
		dynamicCRID = *file.DynamicCRID
	}
	return Config{
		ListenAddr: listenAddr, APIBaseURL: apiBaseURL, APIKey: apiKey,
		AllowedLinkHosts: hosts, CRIDHeader: cridHeader, DynamicCRID: dynamicCRID,
	}, nil
}
