package gateway

import (
	"encoding/base64"
	"fmt"
	"strings"

	"github.com/layervai/qurl-go/qurl"
)

const qurlDeploymentEnv = "QURL_DEPLOYMENT"

// loadPortalConfig converts the operator-supplied SDK deployment into the
// explicit opener config used for every qv2 link. Keeping it per-gateway avoids
// mutating qurl's process-wide default provider and makes the selected trust
// roots visible in the gateway configuration.
func loadPortalConfig(path string) (*qurl.Config, error) {
	deployment, err := qurl.LoadDeployment(path)
	if err != nil {
		return nil, fmt.Errorf("load qurl deployment %s: %w", path, err)
	}
	issuerDER := make(map[string][]byte, len(deployment.Issuers))
	for _, issuer := range deployment.Issuers {
		key, err := base64.RawURLEncoding.DecodeString(strings.TrimSpace(issuer.SPKIDERB64))
		if err != nil {
			return nil, fmt.Errorf("decode qurl deployment issuer %q: %w", issuer.Kid, err)
		}
		issuerDER[issuer.Kid] = key
	}
	trustStore, err := qurl.NewTrustStoreFromDER(issuerDER)
	if err != nil {
		return nil, fmt.Errorf("build qurl deployment trust store: %w", err)
	}

	portalConfig := &qurl.Config{TrustStore: trustStore}
	if len(deployment.RelayAllowlist) > 0 {
		portalConfig.RelayAllowlist = qurl.NewRelayAllowlist(deployment.RelayAllowlist)
	}
	if len(deployment.Cells) > 0 {
		entries := make([]qurl.CellEntry, 0, len(deployment.Cells))
		for _, cell := range deployment.Cells {
			entries = append(entries, qurl.CellEntry{
				CellID: cell.CellID, Host: cell.Host, Port: cell.Port,
				ServerPublicKeyB64: cell.ServerPublicKeyB64,
			})
		}
		portalConfig.Cells, err = qurl.NewCellCatalog(entries)
		if err != nil {
			return nil, fmt.Errorf("build qurl deployment cell catalog: %w", err)
		}
	}
	if portalConfig.RelayAllowlist == nil && portalConfig.Cells == nil {
		return nil, fmt.Errorf("qurl deployment %s has neither relay_allowlist nor cells", path)
	}
	return portalConfig, nil
}
