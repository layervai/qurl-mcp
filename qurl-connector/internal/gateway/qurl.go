package gateway

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/layervai/qurl-go/qurl"
)

// LinkResolver turns a CRID into a freshly minted qURL access link.
type LinkResolver interface {
	Share(context.Context, string) (string, error)
}

type qurlLinkResolver struct {
	client     *qurl.Client
	apiBaseURL string
	apiKey     string
	httpClient *http.Client
}

func NewQURLLinkResolver(config Config, httpClient *http.Client) (LinkResolver, error) {
	if httpClient == nil {
		httpClient = &http.Client{Timeout: 30 * time.Second}
	}
	configuredHTTPClient := *httpClient
	if configuredHTTPClient.Timeout == 0 {
		configuredHTTPClient.Timeout = 30 * time.Second
	}
	configuredHTTPClient.Transport = httpClient.Transport
	client, err := qurl.NewClient(
		qurl.BearerToken(config.APIKey),
		qurl.WithBaseURL(config.APIBaseURL),
		qurl.WithHTTPClient(&configuredHTTPClient),
	)
	if err != nil {
		return nil, fmt.Errorf("create qURL client: %w", err)
	}
	return &qurlLinkResolver{
		client: client, apiBaseURL: strings.TrimRight(config.APIBaseURL, "/"),
		apiKey: config.APIKey, httpClient: &configuredHTTPClient,
	}, nil
}

func (r *qurlLinkResolver) Share(ctx context.Context, crid string) (string, error) {
	link, err := r.client.ShareResource(ctx, strings.TrimSpace(crid), nil)
	if err != nil {
		return "", fmt.Errorf("share CRID: %w", err)
	}
	if link == nil || strings.TrimSpace(link.Link) == "" {
		return "", fmt.Errorf("share CRID: empty qurl link")
	}
	if link.CRID != "" && link.CRID != strings.TrimSpace(crid) {
		return "", fmt.Errorf("share CRID: response CRID mismatch")
	}
	return link.Link, nil
}

// ResolveAccessToken uses qURL's headless resolution API. The API grants
// access to the caller's network address and returns the target URL, which is
// the supported flow for at_ links returned by the qURL share API.
func (r *qurlLinkResolver) ResolveAccessToken(ctx context.Context, token string) (string, error) {
	payload, err := json.Marshal(struct {
		AccessToken string `json:"access_token"`
	}{AccessToken: token})
	if err != nil {
		return "", fmt.Errorf("encode qurl access token: %w", err)
	}
	endpoint := r.apiBaseURL + "/v1/resolve"
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(payload))
	if err != nil {
		return "", fmt.Errorf("create qurl resolve request: %w", err)
	}
	request.Header.Set("Authorization", "Bearer "+r.apiKey)
	request.Header.Set("Content-Type", "application/json")
	response, err := r.httpClient.Do(request)
	if err != nil {
		return "", fmt.Errorf("resolve qurl access token: %w", err)
	}
	defer response.Body.Close()
	var envelope struct {
		Data struct {
			TargetURL string `json:"target_url"`
		} `json:"data"`
		Error any `json:"error"`
	}
	if err := json.NewDecoder(response.Body).Decode(&envelope); err != nil {
		return "", fmt.Errorf("decode qurl resolve response: %w", err)
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return "", fmt.Errorf("qurl resolve returned HTTP %d", response.StatusCode)
	}
	if strings.TrimSpace(envelope.Data.TargetURL) == "" {
		return "", fmt.Errorf("qurl resolve returned an empty target URL")
	}
	return envelope.Data.TargetURL, nil
}

type accessTokenResolver interface {
	ResolveAccessToken(context.Context, string) (string, error)
}

func accessTokenFromLink(raw string) (string, bool) {
	target, err := url.Parse(strings.TrimSpace(raw))
	if err != nil {
		return "", false
	}
	for _, value := range []string{target.Fragment, strings.TrimPrefix(target.Path, "/")} {
		if isAccessToken(value) {
			return value, true
		}
	}
	return "", false
}

func isAccessToken(value string) bool {
	if !strings.HasPrefix(value, "at_") || len(value) < 4 || len(value) > 128 {
		return false
	}
	for _, char := range value[3:] {
		if (char < 'a' || char > 'z') && (char < '0' || char > '9') && char != '_' && char != '-' {
			return false
		}
	}
	return true
}
