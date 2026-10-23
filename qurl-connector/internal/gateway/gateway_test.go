package gateway

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"
)

type recordingResolver struct {
	crid   string
	link   string
	called int
}

type fakePortal struct {
	resourceURL string
	authorized  int
}

func (p *fakePortal) ResourceURL() string { return p.resourceURL }

func (p *fakePortal) AuthorizeContentRequest(request *http.Request) error {
	p.authorized++
	request.Header.Set("Cookie", "qurl_vsession=test-session")
	return nil
}

func (p *fakePortal) CheckContentRedirect(request *http.Request, _ []*http.Request) error {
	if request.URL.Scheme != "https" || request.URL.Host != p.host() {
		return http.ErrUseLastResponse
	}
	return p.AuthorizeContentRequest(request)
}

func (p *fakePortal) host() string {
	u, _ := url.Parse(p.resourceURL)
	return u.Host
}

type fakePortalOpener struct {
	portal *fakePortal
	link   string
	crid   string
	calls  int
}

func (o *fakePortalOpener) Open(_ context.Context, link, crid string) (Portal, error) {
	o.calls++
	o.link = link
	o.crid = crid
	return o.portal, nil
}

func (r *recordingResolver) Share(_ context.Context, crid string) (string, error) {
	r.called++
	r.crid = crid
	return r.link, nil
}

func TestGatewaySharesCRIDAndForwardsThroughLinkRedirect(t *testing.T) {
	var gotPath, gotQuery, gotCRID, gotBody string
	var gotSession, gotCookie string
	upstream := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/link/mcp" {
			w.Header().Set("Location", "/mcp-target")
			w.WriteHeader(http.StatusTemporaryRedirect)
			return
		}
		gotPath, gotQuery, gotCRID = r.URL.Path, r.URL.RawQuery, r.Header.Get("X-QURL-CRID")
		gotSession, gotCookie = r.Header.Get("Mcp-Session-Id"), r.Header.Get("Cookie")
		body, _ := io.ReadAll(r.Body)
		gotBody = string(body)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"jsonrpc":"2.0","id":1,"result":{}}`))
	}))
	defer upstream.Close()
	resolver := &recordingResolver{link: "https://qurl.link/#qv2t1.1.1.1.AQ.AQ.AQ"}
	portal := &fakePortal{resourceURL: upstream.URL + "/link/mcp?access=secret"}
	opener := &fakePortalOpener{portal: portal}
	gateway := NewWithResolverAndOpener(Config{
		ListenAddr: "127.0.0.1:0", CRIDHeader: "X-QURL-CRID",
		AllowedLinkHosts: map[string]struct{}{"qurl.link": {}},
	}, resolver, opener)
	gateway.transport = upstream.Client().Transport

	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/mcp?crid=ignored&keep=yes", strings.NewReader(`{"jsonrpc":"2.0","id":1}`))
	request.Host = "gateway.test"
	request.Header.Set("X-QURL-CRID", "crid-from-header")
	gateway.Handler().ServeHTTP(recorder, request)

	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	if resolver.called != 1 || resolver.crid != "crid-from-header" {
		t.Fatalf("resolver = %#v, want one call with header CRID", resolver)
	}
	if gotPath != "/mcp-target" || gotQuery != "access=secret&keep=yes" {
		t.Errorf("upstream path/query = %q?%s, want /mcp-target?access=secret&keep=yes", gotPath, gotQuery)
	}
	if gotCRID != "" {
		t.Errorf("CRID header leaked upstream: %q", gotCRID)
	}
	if gotBody != `{"jsonrpc":"2.0","id":1}` {
		t.Errorf("upstream body = %q", gotBody)
	}
	if gotSession != "" {
		t.Errorf("initial request leaked an unexpected MCP session ID upstream: %q", gotSession)
	}
	if gotCookie != "qurl_vsession=test-session" {
		t.Errorf("portal authorization cookie = %q", gotCookie)
	}
	if opener.calls != 1 || opener.link != resolver.link || opener.crid != "crid-from-header" || portal.authorized != 2 {
		t.Errorf("portal open calls=%d authorized requests=%d link=%q crid=%q", opener.calls, portal.authorized, opener.link, opener.crid)
	}
}

func TestGatewayReusesPortalForExistingMCPSession(t *testing.T) {
	var upstreamSessions []string
	upstream := httptest.NewTLSServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		upstreamSessions = append(upstreamSessions, request.Header.Get("Mcp-Session-Id"))
		if request.Header.Get("Mcp-Session-Id") == "" {
			writer.Header().Set("Mcp-Session-Id", "session-123")
		}
		writer.Header().Set("Content-Type", "application/json")
		_, _ = writer.Write([]byte(`{"jsonrpc":"2.0","id":1,"result":{}}`))
	}))
	defer upstream.Close()

	resolver := &recordingResolver{link: "https://qurl.link/#qv2t1.1.1.1.AQ.AQ.AQ"}
	portal := &fakePortal{resourceURL: upstream.URL + "/mcp"}
	opener := &fakePortalOpener{portal: portal}
	gateway := NewWithResolverAndOpener(Config{
		AllowedLinkHosts: map[string]struct{}{"qurl.link": {}},
	}, resolver, opener)
	gateway.transport = upstream.Client().Transport

	initialize := httptest.NewRequest(http.MethodPost, "/mcp", strings.NewReader(`{"jsonrpc":"2.0","id":1,"method":"initialize"}`))
	initialize.Header.Set("X-MCP-CRID", "resource-crid")
	initializeRecorder := httptest.NewRecorder()
	gateway.Handler().ServeHTTP(initializeRecorder, initialize)
	if initializeRecorder.Code != http.StatusOK || initializeRecorder.Header().Get("Mcp-Session-Id") != "session-123" {
		t.Fatalf("initialize status=%d session=%q", initializeRecorder.Code, initializeRecorder.Header().Get("Mcp-Session-Id"))
	}

	toolCall := httptest.NewRequest(http.MethodPost, "/mcp", strings.NewReader(`{"jsonrpc":"2.0","id":2,"method":"tools/list"}`))
	toolCall.Header.Set("Mcp-Session-Id", "session-123")
	toolCallRecorder := httptest.NewRecorder()
	gateway.Handler().ServeHTTP(toolCallRecorder, toolCall)
	if toolCallRecorder.Code != http.StatusOK {
		t.Fatalf("tool call status=%d body=%s", toolCallRecorder.Code, toolCallRecorder.Body.String())
	}
	if resolver.called != 1 || opener.calls != 1 {
		t.Fatalf("share calls=%d portal opens=%d, want one each", resolver.called, opener.calls)
	}
	if got := strings.Join(upstreamSessions, ","); got != ",session-123" {
		t.Fatalf("upstream MCP sessions=%q, want initial empty then session-123", got)
	}
	if portal.authorized != 2 {
		t.Fatalf("portal authorizations=%d, want 2", portal.authorized)
	}
}

func TestGatewayRejectsUnknownMCPSessionWithoutSharing(t *testing.T) {
	resolver := &recordingResolver{link: "https://qurl.link/#qv2t1.1.1.1.AQ.AQ.AQ"}
	gateway := NewWithResolver(Config{CRIDHeader: "X-MCP-CRID"}, resolver)
	request := httptest.NewRequest(http.MethodPost, "/mcp", strings.NewReader(`{"jsonrpc":"2.0","id":1,"method":"tools/list"}`))
	request.Header.Set("Mcp-Session-Id", "unknown-session")
	request.Header.Set("X-MCP-CRID", "resource-crid")
	recorder := httptest.NewRecorder()
	gateway.Handler().ServeHTTP(recorder, request)
	if recorder.Code != http.StatusNotFound || resolver.called != 0 {
		t.Fatalf("status=%d share calls=%d, want 404 and no share", recorder.Code, resolver.called)
	}
}

func TestGatewayDeletesPortalWhenMCPSessionIsDeleted(t *testing.T) {
	upstream := httptest.NewTLSServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.Header.Get("Mcp-Session-Id") == "" {
			writer.Header().Set("Mcp-Session-Id", "session-123")
		}
		writer.WriteHeader(http.StatusOK)
	}))
	defer upstream.Close()
	resolver := &recordingResolver{link: "https://qurl.link/#qv2t1.1.1.1.AQ.AQ.AQ"}
	gateway := NewWithResolverAndOpener(Config{
		AllowedLinkHosts: map[string]struct{}{"qurl.link": {}},
	}, resolver, &fakePortalOpener{portal: &fakePortal{resourceURL: upstream.URL + "/mcp"}})
	gateway.transport = upstream.Client().Transport

	initialize := httptest.NewRequest(http.MethodPost, "/mcp", strings.NewReader(`{"jsonrpc":"2.0","id":1,"method":"initialize"}`))
	initialize.Header.Set("X-MCP-CRID", "resource-crid")
	gateway.Handler().ServeHTTP(httptest.NewRecorder(), initialize)

	deleteRequest := httptest.NewRequest(http.MethodDelete, "/mcp", nil)
	deleteRequest.Header.Set("Mcp-Session-Id", "session-123")
	deleteRecorder := httptest.NewRecorder()
	gateway.Handler().ServeHTTP(deleteRecorder, deleteRequest)
	if deleteRecorder.Code != http.StatusOK {
		t.Fatalf("delete status=%d", deleteRecorder.Code)
	}

	staleRequest := httptest.NewRequest(http.MethodGet, "/mcp", nil)
	staleRequest.Header.Set("Mcp-Session-Id", "session-123")
	staleRecorder := httptest.NewRecorder()
	gateway.Handler().ServeHTTP(staleRecorder, staleRequest)
	if staleRecorder.Code != http.StatusNotFound || resolver.called != 1 {
		t.Fatalf("stale session status=%d share calls=%d", staleRecorder.Code, resolver.called)
	}
}

func TestGatewayRetainsPortalWhenMCPSessionDeleteFails(t *testing.T) {
	var deleteAttempts int
	upstream := httptest.NewTLSServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.Header.Get("Mcp-Session-Id") == "" {
			writer.Header().Set("Mcp-Session-Id", "session-123")
			writer.WriteHeader(http.StatusOK)
			return
		}
		if request.Method == http.MethodDelete {
			deleteAttempts++
			writer.WriteHeader(http.StatusInternalServerError)
			return
		}
		writer.WriteHeader(http.StatusOK)
	}))
	defer upstream.Close()

	resolver := &recordingResolver{link: "https://qurl.link/#qv2t1.1.1.1.AQ.AQ.AQ"}
	gateway := NewWithResolverAndOpener(Config{
		AllowedLinkHosts: map[string]struct{}{"qurl.link": {}},
	}, resolver, &fakePortalOpener{portal: &fakePortal{resourceURL: upstream.URL + "/mcp"}})
	gateway.transport = upstream.Client().Transport

	initialize := httptest.NewRequest(http.MethodPost, "/mcp", strings.NewReader(`{"jsonrpc":"2.0","id":1,"method":"initialize"}`))
	initialize.Header.Set("X-MCP-CRID", "resource-crid")
	gateway.Handler().ServeHTTP(httptest.NewRecorder(), initialize)

	deleteRequest := httptest.NewRequest(http.MethodDelete, "/mcp", nil)
	deleteRequest.Header.Set("Mcp-Session-Id", "session-123")
	deleteRecorder := httptest.NewRecorder()
	gateway.Handler().ServeHTTP(deleteRecorder, deleteRequest)
	if deleteRecorder.Code != http.StatusInternalServerError || deleteAttempts != 1 {
		t.Fatalf("delete status=%d attempts=%d", deleteRecorder.Code, deleteAttempts)
	}

	followUp := httptest.NewRequest(http.MethodGet, "/mcp", nil)
	followUp.Header.Set("Mcp-Session-Id", "session-123")
	followUpRecorder := httptest.NewRecorder()
	gateway.Handler().ServeHTTP(followUpRecorder, followUp)
	if followUpRecorder.Code != http.StatusOK || resolver.called != 1 {
		t.Fatalf("follow-up status=%d share calls=%d, want 200 and one share", followUpRecorder.Code, resolver.called)
	}
}

func TestGatewayPurgesExpiredSessionsWithoutAnotherRequest(t *testing.T) {
	gateway := NewWithResolver(Config{}, &recordingResolver{})
	now := time.Now()
	gateway.sessions["idle"] = &mcpSession{
		createdAt:  now.Add(-time.Minute),
		lastUsedAt: now.Add(-mcpSessionIdleTTL),
	}
	gateway.sessions["absolute"] = &mcpSession{
		createdAt:  now.Add(-mcpSessionAbsoluteTTL),
		lastUsedAt: now,
	}
	gateway.sessions["active"] = &mcpSession{
		createdAt:  now.Add(-time.Minute),
		lastUsedAt: now,
	}

	if removed := gateway.purgeExpiredSessions(now); removed != 2 {
		t.Fatalf("removed=%d, want 2", removed)
	}
	if len(gateway.sessions) != 1 || gateway.sessions["active"] == nil {
		t.Fatalf("sessions after cleanup = %#v, want only active", gateway.sessions)
	}
}

func TestGatewaySupportsMultipleMCPConfigsWithDifferentCRIDs(t *testing.T) {
	upstream := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"jsonrpc":"2.0","id":1,"result":{}}`))
	}))
	defer upstream.Close()
	resolver := &recordingResolver{link: "https://qurl.link/#qv2t1.1.1.1.AQ.AQ.AQ"}
	opener := &fakePortalOpener{portal: &fakePortal{resourceURL: upstream.URL + "/mcp"}}
	gateway := NewWithResolverAndOpener(Config{
		AllowedLinkHosts: map[string]struct{}{"qurl.link": {}},
	}, resolver, opener)
	gateway.transport = upstream.Client().Transport

	for _, crid := range []string{"uuid-aaaa", "uuid-bbbb"} {
		recorder := httptest.NewRecorder()
		request := httptest.NewRequest(http.MethodPost, "/mcp", strings.NewReader(`{"jsonrpc":"2.0","id":1}`))
		request.Header.Set("X-MCP-CRID", crid)
		gateway.Handler().ServeHTTP(recorder, request)
		if recorder.Code != http.StatusOK {
			t.Fatalf("CRID %q status = %d, body = %s", crid, recorder.Code, recorder.Body.String())
		}
		if resolver.crid != crid {
			t.Fatalf("resolver CRID = %q, want %q", resolver.crid, crid)
		}
	}
	if resolver.called != 2 {
		t.Fatalf("resolver calls = %d, want one call per MCP configuration request", resolver.called)
	}
}

func TestGatewayRequiresCRID(t *testing.T) {
	resolver := &recordingResolver{}
	gateway := NewWithResolver(Config{CRIDHeader: "X-QURL-CRID"}, resolver)
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/mcp", strings.NewReader(`{}`))
	gateway.Handler().ServeHTTP(recorder, request)
	if recorder.Code != http.StatusBadRequest || resolver.called != 0 {
		t.Fatalf("status = %d, resolver calls = %d", recorder.Code, resolver.called)
	}
}

func TestGatewayAcceptsTopLevelBodyCRID(t *testing.T) {
	upstream := httptest.NewTLSServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		writer.WriteHeader(http.StatusNoContent)
	}))
	defer upstream.Close()
	resolver := &recordingResolver{link: "https://qurl.link/#qv2t1.1.1.1.AQ.AQ.AQ"}
	gateway := NewWithResolverAndOpener(Config{
		CRIDHeader: "X-QURL-CRID", AllowedLinkHosts: map[string]struct{}{"qurl.link": {}},
	}, resolver, &fakePortalOpener{portal: &fakePortal{resourceURL: upstream.URL + "/mcp"}})
	gateway.transport = upstream.Client().Transport
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/mcp", strings.NewReader(`{"jsonrpc":"2.0","crid":"body-crid"}`))
	gateway.Handler().ServeHTTP(recorder, request)
	if resolver.crid != "body-crid" || recorder.Code != http.StatusNoContent {
		t.Fatalf("resolver CRID = %q, status = %d", resolver.crid, recorder.Code)
	}
}

func TestGatewayRejectsUntrustedLinkHost(t *testing.T) {
	resolver := &recordingResolver{link: "https://evil.example/#qv2t1.1.1.1.AQ.AQ.AQ"}
	gateway := NewWithResolverAndOpener(Config{
		CRIDHeader:       "X-QURL-CRID",
		AllowedLinkHosts: map[string]struct{}{"qurl.link": {}},
	}, resolver, &fakePortalOpener{portal: &fakePortal{resourceURL: "https://resource.example/mcp"}})
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, "/mcp", nil)
	request.Header.Set("X-QURL-CRID", "crid")
	gateway.Handler().ServeHTTP(recorder, request)
	if recorder.Code != http.StatusBadGateway {
		t.Fatalf("status = %d, want 502", recorder.Code)
	}
}

func TestGatewayRejectsNonCredentialLinkBeforeOpeningPortal(t *testing.T) {
	opener := &fakePortalOpener{portal: &fakePortal{resourceURL: "https://resource.example/mcp"}}
	resolver := &recordingResolver{link: "https://qurl.link/plain"}
	gateway := NewWithResolverAndOpener(Config{
		CRIDHeader: "X-MCP-CRID", AllowedLinkHosts: map[string]struct{}{"qurl.link": {}},
	}, resolver, opener)
	request := httptest.NewRequest(http.MethodGet, "/mcp", nil)
	request.Header.Set("X-MCP-CRID", "crid")
	recorder := httptest.NewRecorder()
	gateway.Handler().ServeHTTP(recorder, request)
	if recorder.Code != http.StatusBadGateway || opener.calls != 0 {
		t.Fatalf("status=%d portal opens=%d", recorder.Code, opener.calls)
	}
}

type fakeAccessResolver struct {
	token  string
	target string
}

func (r *fakeAccessResolver) ResolveAccessToken(_ context.Context, token string) (string, error) {
	r.token = token
	return r.target, nil
}

func TestQURLPortalOpenerResolvesHeadlessAccessTokenLink(t *testing.T) {
	access := &fakeAccessResolver{target: "https://resource.example/mcp"}
	portal, err := (qurlPortalOpener{access: access}).Open(context.Background(), "https://qurl.link/at_abc123", "test-crid")
	if err != nil {
		t.Fatal(err)
	}
	if access.token != "at_abc123" || portal.ResourceURL() != access.target {
		t.Fatalf("token=%q resource=%q", access.token, portal.ResourceURL())
	}
}

func TestAccessTokenFromLinkSupportsPathAndFragment(t *testing.T) {
	for _, link := range []string{
		"https://qurl.link/at_abc123",
		"https://qurl.link/#at_abc123",
	} {
		if token, ok := accessTokenFromLink(link); !ok || token != "at_abc123" {
			t.Fatalf("accessTokenFromLink(%q) = %q, %t", link, token, ok)
		}
	}
}

func TestGatewayStreamsMCPSSE(t *testing.T) {
	upstream := httptest.NewTLSServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		writer.Header().Set("Content-Type", "text/event-stream")
		writer.WriteHeader(http.StatusOK)
		_, _ = io.WriteString(writer, "event: message\\ndata: first\\n\\n")
		writer.(http.Flusher).Flush()
		_, _ = io.WriteString(writer, "event: message\\ndata: second\\n\\n")
	}))
	defer upstream.Close()
	resolver := &recordingResolver{link: "https://qurl.link/#qv2t1.1.1.1.AQ.AQ.AQ"}
	gateway := NewWithResolverAndOpener(Config{
		AllowedLinkHosts: map[string]struct{}{"qurl.link": {}},
	}, resolver, &fakePortalOpener{portal: &fakePortal{resourceURL: upstream.URL + "/mcp"}})
	gateway.transport = upstream.Client().Transport
	request := httptest.NewRequest(http.MethodGet, "/mcp?keep=yes", nil)
	request.Header.Set("X-MCP-CRID", "stream-crid")
	recorder := httptest.NewRecorder()
	gateway.Handler().ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK || !strings.HasPrefix(recorder.Header().Get("Content-Type"), "text/event-stream") {
		t.Fatalf("status=%d content-type=%q", recorder.Code, recorder.Header().Get("Content-Type"))
	}
	if !recorder.Flushed || !strings.Contains(recorder.Body.String(), "data: first") || !strings.Contains(recorder.Body.String(), "data: second") {
		t.Fatalf("SSE was not streamed: flushed=%t body=%q", recorder.Flushed, recorder.Body.String())
	}
}
