package gateway

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"encoding/base64"
	"os"
	"path/filepath"
	"testing"
)

func TestLoadPortalConfigBuildsRelayOnlySDKConfig(t *testing.T) {
	privateKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	der, err := x509.MarshalPKIXPublicKey(&privateKey.PublicKey)
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(t.TempDir(), "deployment.json")
	deployment := `{
  "issuers": [{"kid":"test-issuer","spki_der_b64":"` + base64.RawURLEncoding.EncodeToString(der) + `"}],
  "cells": [],
  "relay_allowlist": ["relay.example.test"]
}`
	if err := os.WriteFile(path, []byte(deployment), 0o600); err != nil {
		t.Fatal(err)
	}
	config, err := loadPortalConfig(path)
	if err != nil {
		t.Fatal(err)
	}
	if config.TrustStore == nil || config.RelayAllowlist == nil || config.Cells != nil {
		t.Fatalf("portal config = %#v", config)
	}
}

func TestLoadPortalConfigRejectsPlaceholderIssuerKey(t *testing.T) {
	path := filepath.Join(t.TempDir(), "deployment.json")
	if err := os.WriteFile(path, []byte(`{
  "issuers": [{"kid":"test-issuer","spki_der_b64":"PASTE_BASE64URL_SPKI_DER_HERE"}],
  "cells": [],
  "relay_allowlist": ["relay.example.test"]
}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := loadPortalConfig(path); err == nil {
		t.Fatal("loadPortalConfig unexpectedly accepted a placeholder issuer key")
	}
}
