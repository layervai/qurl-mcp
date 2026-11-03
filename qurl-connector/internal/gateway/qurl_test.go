package gateway

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

const testCRID = "ae4jqpd7eaoslq7jinmjv4yikgzmcxgpjfsuobiniqnko32lpw743ivbeyha"

func TestQURLLinkResolverUsesCRIDShareEndpoint(t *testing.T) {
	api := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.Method != http.MethodPost || request.URL.Path != "/v1/resources/"+testCRID+"/share" {
			t.Fatalf("request = %s %s", request.Method, request.URL.Path)
		}
		if got := request.Header.Get("Authorization"); got != "Bearer test-key" {
			t.Fatalf("authorization = %q", got)
		}
		if got := request.Header.Get("X-QURL-Owner"); got != "" {
			t.Fatalf("unexpected owner = %q", got)
		}
		writer.Header().Set("Content-Type", "application/json")
		_, _ = fmt.Fprintf(writer, `{"data":{"qurl":"https://qurl.link/at_test","crid":%q,"type":"qv2","expires_in_seconds":300,"single_use":false}}`, testCRID)
	}))
	defer api.Close()

	resolver, err := NewQURLLinkResolver(Config{APIBaseURL: api.URL, APIKey: "test-key"}, api.Client())
	if err != nil {
		t.Fatal(err)
	}
	link, err := resolver.Share(context.Background(), testCRID)
	if err != nil {
		t.Fatal(err)
	}
	if link != "https://qurl.link/at_test" {
		t.Fatalf("link = %q", link)
	}
}

func TestQURLLinkResolverResolvesAccessTokenForHeadlessClients(t *testing.T) {
	api := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.Method != http.MethodPost || request.URL.Path != "/v1/resolve" {
			t.Fatalf("request = %s %s", request.Method, request.URL.Path)
		}
		if got := request.Header.Get("Authorization"); got != "Bearer test-key" {
			t.Fatalf("authorization = %q", got)
		}
		body := make([]byte, 128)
		n, _ := request.Body.Read(body)
		if !strings.Contains(string(body[:n]), `"access_token":"at_test_token"`) {
			t.Fatalf("request body = %q", body[:n])
		}
		writer.Header().Set("Content-Type", "application/json")
		_, _ = fmt.Fprint(writer, `{"data":{"target_url":"https://resource.example/mcp","resource_id":"r_test","access_grant":{"expires_in":300}}}`)
	}))
	defer api.Close()

	resolver, err := NewQURLLinkResolver(Config{APIBaseURL: api.URL, APIKey: "test-key"}, api.Client())
	if err != nil {
		t.Fatal(err)
	}
	target, err := resolver.(accessTokenResolver).ResolveAccessToken(context.Background(), "at_test_token")
	if err != nil {
		t.Fatal(err)
	}
	if target != "https://resource.example/mcp" {
		t.Fatalf("target = %q", target)
	}
}
