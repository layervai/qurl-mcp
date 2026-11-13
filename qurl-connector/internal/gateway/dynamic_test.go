package gateway

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

// fakeBackendMCP is a minimal Streamable HTTP MCP server. tools/list replies
// with JSON and tools/call replies with an SSE stream that starts with a
// progress notification.
type fakeBackendMCP struct {
	mu          sync.Mutex
	initializes int
	deletes     int
	sessions    map[string]bool
	methods     []string
	lastCall    json.RawMessage
	cookies     []string
	rejectOnce  bool
	// plainHTTP makes the server behave like a protected web page instead
	// of an MCP server.
	plainHTTP bool
}

func newFakeBackendMCP() *fakeBackendMCP {
	return &fakeBackendMCP{sessions: map[string]bool{}}
}

func (b *fakeBackendMCP) expireAll() {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.sessions = map[string]bool{}
}

func (b *fakeBackendMCP) ServeHTTP(writer http.ResponseWriter, request *http.Request) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.cookies = append(b.cookies, request.Header.Get("Cookie"))
	sessionID := request.Header.Get("Mcp-Session-Id")
	if request.Method == http.MethodDelete {
		b.deletes++
		delete(b.sessions, sessionID)
		writer.WriteHeader(http.StatusOK)
		return
	}
	if b.plainHTTP {
		writer.Header().Set("Content-Type", "text/html")
		_, _ = io.WriteString(writer, "<!doctype html><title>Beyond the Map's Edge</title>")
		return
	}
	var message jsonRPCMessage
	body, _ := io.ReadAll(request.Body)
	_ = json.Unmarshal(body, &message)
	b.methods = append(b.methods, message.Method)
	if message.Method == "initialize" {
		b.initializes++
		sessionID = fmt.Sprintf("backend-session-%d", b.initializes)
		b.sessions[sessionID] = true
		writer.Header().Set("Mcp-Session-Id", sessionID)
		writer.Header().Set("Content-Type", "application/json")
		_, _ = fmt.Fprintf(writer, `{"jsonrpc":"2.0","id":%s,"result":{"protocolVersion":"2025-03-26","capabilities":{"tools":{}},"serverInfo":{"name":"backend","version":"1"}}}`, message.ID)
		return
	}
	if b.rejectOnce {
		b.rejectOnce = false
		http.Error(writer, "portal authorization rejected", http.StatusUnauthorized)
		return
	}
	if !b.sessions[sessionID] {
		http.Error(writer, "session not found", http.StatusNotFound)
		return
	}
	if request.Header.Get("MCP-Protocol-Version") != "2025-03-26" {
		http.Error(writer, "missing negotiated protocol version", http.StatusBadRequest)
		return
	}
	switch message.Method {
	case "notifications/initialized":
		writer.WriteHeader(http.StatusAccepted)
	case "tools/list":
		writer.Header().Set("Content-Type", "application/json")
		_, _ = fmt.Fprintf(writer, `{"jsonrpc":"2.0","id":%s,"result":{"tools":[{"name":"echo","inputSchema":{"type":"object"}}]}}`, message.ID)
	case "tools/call":
		b.lastCall = message.Params
		writer.Header().Set("Content-Type", "text/event-stream")
		_, _ = io.WriteString(writer, "event: message\ndata: {\"jsonrpc\":\"2.0\",\"method\":\"notifications/progress\",\"params\":{}}\n\n")
		_, _ = fmt.Fprintf(writer, "event: message\ndata: {\"jsonrpc\":\"2.0\",\"id\":%s,\"result\":{\"content\":[{\"type\":\"text\",\"text\":\"hello\"}]}}\n\n", message.ID)
	default:
		writer.Header().Set("Content-Type", "application/json")
		_, _ = fmt.Fprintf(writer, `{"jsonrpc":"2.0","id":%s,"error":{"code":-32601,"message":"not found"}}`, message.ID)
	}
}

type dynamicHarness struct {
	t        *testing.T
	gateway  *Gateway
	backend  *fakeBackendMCP
	resolver *recordingResolver
	opener   *fakePortalOpener
	session  string
}

func newDynamicHarness(t *testing.T) *dynamicHarness {
	t.Helper()
	backend := newFakeBackendMCP()
	upstream := httptest.NewTLSServer(backend)
	t.Cleanup(upstream.Close)
	resolver := &recordingResolver{link: "https://qurl.link/#qv2t1.1.1.1.AQ.AQ.AQ"}
	opener := &fakePortalOpener{portal: &fakePortal{resourceURL: upstream.URL + "/mcp"}}
	gateway := NewWithResolverAndOpener(Config{
		DynamicCRID: true, AllowedLinkHosts: map[string]struct{}{"qurl.link": {}},
	}, resolver, opener)
	gateway.transport = upstream.Client().Transport
	return &dynamicHarness{t: t, gateway: gateway, backend: backend, resolver: resolver, opener: opener}
}

func (h *dynamicHarness) post(body string) *httptest.ResponseRecorder {
	h.t.Helper()
	request := httptest.NewRequest(http.MethodPost, "/mcp", strings.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	if h.session != "" {
		request.Header.Set("Mcp-Session-Id", h.session)
	}
	recorder := httptest.NewRecorder()
	h.gateway.Handler().ServeHTTP(recorder, request)
	return recorder
}

func (h *dynamicHarness) initialize() {
	h.t.Helper()
	recorder := h.post(`{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"test","version":"1"}}}`)
	if recorder.Code != http.StatusOK {
		h.t.Fatalf("initialize status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	h.session = recorder.Header().Get("Mcp-Session-Id")
	if !strings.HasPrefix(h.session, "qc_") {
		h.t.Fatalf("dynamic session ID = %q", h.session)
	}
	var response struct {
		Result struct {
			ProtocolVersion string `json:"protocolVersion"`
			ServerInfo      struct {
				Name string `json:"name"`
			} `json:"serverInfo"`
		} `json:"result"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
		h.t.Fatal(err)
	}
	if response.Result.ProtocolVersion != "2025-06-18" || response.Result.ServerInfo.Name != connectorName {
		h.t.Fatalf("initialize result = %s", recorder.Body.String())
	}
	if initialized := h.post(`{"jsonrpc":"2.0","method":"notifications/initialized"}`); initialized.Code != http.StatusAccepted {
		h.t.Fatalf("notifications/initialized status=%d", initialized.Code)
	}
}

type toolCallResponse struct {
	Result struct {
		Content []struct {
			Text string `json:"text"`
		} `json:"content"`
		StructuredContent map[string]json.RawMessage `json:"structuredContent"`
		IsError           bool                       `json:"isError"`
	} `json:"result"`
	Error *jsonRPCError `json:"error"`
}

func (h *dynamicHarness) callTool(id int, name, arguments string) toolCallResponse {
	h.t.Helper()
	recorder := h.post(fmt.Sprintf(`{"jsonrpc":"2.0","id":%d,"method":"tools/call","params":{"name":%q,"arguments":%s}}`, id, name, arguments))
	if recorder.Code != http.StatusOK {
		h.t.Fatalf("tools/call status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	var response toolCallResponse
	if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
		h.t.Fatalf("decode %s: %v", recorder.Body.String(), err)
	}
	return response
}

func TestDynamicCRIDSessionListsAndCallsBackendTools(t *testing.T) {
	h := newDynamicHarness(t)
	h.initialize()
	if h.resolver.called != 0 {
		t.Fatalf("initialize without CRID shared %d time(s)", h.resolver.called)
	}

	listed := h.post(`{"jsonrpc":"2.0","id":2,"method":"tools/list"}`)
	for _, name := range []string{dynamicListToolsName, dynamicCallToolName, dynamicGetLinkName} {
		if !strings.Contains(listed.Body.String(), `"name":"`+name+`"`) {
			t.Fatalf("tools/list missing %s: %s", name, listed.Body.String())
		}
	}

	tools := h.callTool(3, dynamicListToolsName, `{"crid":"crid-a"}`)
	if tools.Error != nil || tools.Result.IsError {
		t.Fatalf("qurl_list_tools failed: %#v", tools)
	}
	if got := string(tools.Result.StructuredContent["tools"]); !strings.Contains(got, `"echo"`) {
		t.Fatalf("backend tools = %s", got)
	}

	called := h.callTool(4, dynamicCallToolName, `{"crid":"crid-a","name":"echo","arguments":{"text":"hi"}}`)
	if called.Error != nil || called.Result.IsError || len(called.Result.Content) != 1 || called.Result.Content[0].Text != "hello" {
		t.Fatalf("qurl_call_tool result = %#v", called)
	}
	if got := string(h.backend.lastCall); got != `{"arguments":{"text":"hi"},"name":"echo"}` {
		t.Fatalf("backend tools/call params = %s", got)
	}
	if h.resolver.called != 1 || h.resolver.crid != "crid-a" || h.backend.initializes != 1 {
		t.Fatalf("share calls=%d crid=%q backend initializes=%d, want one share and one initialize",
			h.resolver.called, h.resolver.crid, h.backend.initializes)
	}
	for _, cookie := range h.backend.cookies {
		if cookie != "qurl_vsession=test-session" {
			t.Fatalf("backend request without portal authorization: %q", h.backend.cookies)
		}
	}

	h.callTool(5, dynamicListToolsName, `{"crid":"crid-b"}`)
	if h.resolver.called != 2 || h.resolver.crid != "crid-b" || h.backend.initializes != 2 {
		t.Fatalf("second CRID: share calls=%d backend initializes=%d", h.resolver.called, h.backend.initializes)
	}

	deleteRequest := httptest.NewRequest(http.MethodDelete, "/mcp", nil)
	deleteRequest.Header.Set("Mcp-Session-Id", h.session)
	deleteRecorder := httptest.NewRecorder()
	h.gateway.Handler().ServeHTTP(deleteRecorder, deleteRequest)
	if deleteRecorder.Code != http.StatusOK || h.backend.deletes != 2 {
		t.Fatalf("delete status=%d backend deletes=%d, want 200 and 2", deleteRecorder.Code, h.backend.deletes)
	}
	if stale := h.post(`{"jsonrpc":"2.0","id":6,"method":"tools/list"}`); stale.Code != http.StatusNotFound {
		t.Fatalf("deleted dynamic session status=%d, want 404", stale.Code)
	}
}

func TestDynamicCRIDReinitializesExpiredBackendSession(t *testing.T) {
	h := newDynamicHarness(t)
	h.initialize()
	h.callTool(2, dynamicListToolsName, `{"crid":"crid-a"}`)
	h.backend.expireAll()
	called := h.callTool(3, dynamicCallToolName, `{"crid":"crid-a","name":"echo"}`)
	if called.Result.IsError || h.backend.initializes != 2 {
		t.Fatalf("result=%#v backend initializes=%d, want transparent re-initialize", called, h.backend.initializes)
	}
	if got := string(h.backend.lastCall); got != `{"arguments":{},"name":"echo"}` {
		t.Fatalf("backend tools/call params = %s", got)
	}
	// The qURL portal stays valid; only the backend MCP session is renewed.
	if h.resolver.called != 1 {
		t.Fatalf("share calls=%d, want 1", h.resolver.called)
	}
}

func TestDynamicCRIDSharesAgainWhenPortalIsRejected(t *testing.T) {
	h := newDynamicHarness(t)
	h.initialize()
	h.callTool(2, dynamicListToolsName, `{"crid":"crid-a"}`)
	h.backend.rejectOnce = true
	called := h.callTool(3, dynamicCallToolName, `{"crid":"crid-a","name":"echo"}`)
	if called.Result.IsError || h.resolver.called != 2 || h.opener.calls != 2 {
		t.Fatalf("result=%#v share calls=%d portal opens=%d, want a second share", called, h.resolver.called, h.opener.calls)
	}
}

func TestDynamicCRIDReportsBackendAndValidationErrors(t *testing.T) {
	h := newDynamicHarness(t)
	h.initialize()
	if missing := h.callTool(2, dynamicListToolsName, `{}`); missing.Error == nil || missing.Error.Code != jsonRPCInvalidParams {
		t.Fatalf("missing CRID response = %#v", missing)
	}
	if badArgs := h.callTool(3, dynamicCallToolName, `{"crid":"c","name":"echo","arguments":[1]}`); badArgs.Error == nil {
		t.Fatalf("array arguments response = %#v", badArgs)
	}
	if unknown := h.callTool(4, "nope", `{}`); unknown.Error == nil {
		t.Fatalf("unknown tool response = %#v", unknown)
	}

	h.resolver.link = "https://evil.example/#qv2t1.1.1.1.AQ.AQ.AQ"
	rejected := h.callTool(5, dynamicListToolsName, `{"crid":"crid-a"}`)
	if !rejected.Result.IsError || rejected.Result.Content[0].Text != "invalid qurl link" || h.opener.calls != 0 {
		t.Fatalf("untrusted link result=%#v portal opens=%d", rejected, h.opener.calls)
	}
}

func TestDynamicCRIDGetLinkReturnsLinkWithoutBackend(t *testing.T) {
	h := newDynamicHarness(t)
	h.initialize()
	got := h.callTool(2, dynamicGetLinkName, `{"crid":" $crid-a "}`)
	if got.Error != nil || got.Result.IsError || len(got.Result.Content) != 1 || got.Result.Content[0].Text != h.resolver.link {
		t.Fatalf("qurl_get_link result = %#v", got)
	}
	if string(got.Result.StructuredContent["crid"]) != `"crid-a"` || string(got.Result.StructuredContent["link"]) != fmt.Sprintf("%q", h.resolver.link) {
		t.Fatalf("structured content = %#v", got.Result.StructuredContent)
	}
	if h.resolver.called != 1 || h.resolver.crid != "crid-a" || h.opener.calls != 0 || len(h.backend.methods) != 0 {
		t.Fatalf("share calls=%d crid=%q portal opens=%d backend methods=%v, want one share and no backend traffic",
			h.resolver.called, h.resolver.crid, h.opener.calls, h.backend.methods)
	}
	// Every call mints a fresh link.
	h.callTool(3, dynamicGetLinkName, `{"crid":"crid-a"}`)
	if h.resolver.called != 2 {
		t.Fatalf("share calls=%d, want 2", h.resolver.called)
	}

	if missing := h.callTool(4, dynamicGetLinkName, `{"crid":"$"}`); missing.Error == nil || missing.Error.Code != jsonRPCInvalidParams {
		t.Fatalf("missing CRID response = %#v", missing)
	}
	h.resolver.link = "https://evil.example/#qv2t1.1.1.1.AQ.AQ.AQ"
	rejected := h.callTool(5, dynamicGetLinkName, `{"crid":"crid-a"}`)
	if !rejected.Result.IsError || rejected.Result.Content[0].Text != "invalid qurl link" {
		t.Fatalf("untrusted link result = %#v", rejected)
	}
}

func TestDynamicCRIDSuggestsGetLinkForHTTPService(t *testing.T) {
	h := newDynamicHarness(t)
	h.backend.plainHTTP = true
	h.initialize()
	listed := h.callTool(2, dynamicListToolsName, `{"crid":"crid-web"}`)
	if !listed.Result.IsError || !strings.Contains(listed.Result.Content[0].Text, dynamicGetLinkName) {
		t.Fatalf("qurl_list_tools on HTTP service = %#v, want an error that suggests %s", listed, dynamicGetLinkName)
	}
	got := h.callTool(3, dynamicGetLinkName, `{"crid":"crid-web"}`)
	if got.Result.IsError || got.Result.Content[0].Text != h.resolver.link {
		t.Fatalf("qurl_get_link on HTTP service = %#v", got)
	}
}

func TestDynamicCRIDRejectsCRIDHeaderOnDynamicSession(t *testing.T) {
	h := newDynamicHarness(t)
	h.initialize()
	request := httptest.NewRequest(http.MethodPost, "/mcp", strings.NewReader(`{"jsonrpc":"2.0","id":2,"method":"tools/list"}`))
	request.Header.Set("Mcp-Session-Id", h.session)
	request.Header.Set("X-MCP-CRID", "crid-a")
	recorder := httptest.NewRecorder()
	h.gateway.Handler().ServeHTTP(recorder, request)
	if recorder.Code != http.StatusConflict {
		t.Fatalf("status=%d, want 409", recorder.Code)
	}
}

func TestDynamicCRIDDisabledStillRequiresCRID(t *testing.T) {
	resolver := &recordingResolver{}
	gateway := NewWithResolver(Config{}, resolver)
	request := httptest.NewRequest(http.MethodPost, "/mcp", strings.NewReader(`{"jsonrpc":"2.0","id":1,"method":"initialize"}`))
	recorder := httptest.NewRecorder()
	gateway.Handler().ServeHTTP(recorder, request)
	if recorder.Code != http.StatusBadRequest || resolver.called != 0 {
		t.Fatalf("status=%d share calls=%d, want 400 and no share", recorder.Code, resolver.called)
	}
}

func TestPurgeExpiresDynamicSessions(t *testing.T) {
	gateway := NewWithResolver(Config{DynamicCRID: true}, &recordingResolver{})
	now := time.Now()
	gateway.dynamicSessions["idle"] = &dynamicSession{
		createdAt: now.Add(-time.Minute), lastUsedAt: now.Add(-mcpSessionIdleTTL),
		backends: map[string]*dynamicBackend{},
	}
	gateway.dynamicSessions["active"] = &dynamicSession{
		createdAt: now, lastUsedAt: now, backends: map[string]*dynamicBackend{},
	}
	if removed := gateway.purgeExpiredSessions(now); removed != 1 {
		t.Fatalf("removed=%d, want 1", removed)
	}
	if len(gateway.dynamicSessions) != 1 || gateway.dynamicSessions["active"] == nil {
		t.Fatalf("dynamic sessions after cleanup = %#v", gateway.dynamicSessions)
	}
}

func TestReadSSEResponseSkipsUnrelatedMessages(t *testing.T) {
	stream := "data: {\"jsonrpc\":\"2.0\",\"id\":9,\"result\":{}}\n\n" +
		"data: {\"jsonrpc\":\"2.0\",\n" +
		"data: \"id\":7,\"result\":{\"ok\":true}}\n"
	reply, err := readSSEResponse(strings.NewReader(stream), json.RawMessage("7"))
	if err != nil || string(reply.Result) != `{"ok":true}` {
		t.Fatalf("reply=%#v err=%v", reply, err)
	}
	if _, err := readSSEResponse(strings.NewReader("data: {}\n\n"), json.RawMessage("7")); err == nil {
		t.Fatal("expected error for stream without a response")
	}
}

func TestDynamicCRIDAcceptsDollarPrefixedCRID(t *testing.T) {
	h := newDynamicHarness(t)
	h.initialize()
	tools := h.callTool(2, dynamicListToolsName, `{"crid":" $crid-a "}`)
	if tools.Result.IsError || string(tools.Result.StructuredContent["crid"]) != `"crid-a"` {
		t.Fatalf("tools result = %#v", tools)
	}
	called := h.callTool(3, dynamicCallToolName, `{"crid":"crid-a","name":"echo"}`)
	if called.Result.IsError {
		t.Fatalf("call result = %#v", called)
	}
	if h.resolver.called != 1 || h.resolver.crid != "crid-a" || h.backend.initializes != 1 {
		t.Fatalf("share calls=%d crid=%q backend initializes=%d, want $crid-a and crid-a to share one backend",
			h.resolver.called, h.resolver.crid, h.backend.initializes)
	}
	if empty := h.callTool(4, dynamicListToolsName, `{"crid":"$"}`); empty.Error == nil || empty.Error.Code != jsonRPCInvalidParams {
		t.Fatalf("empty dollar-prefixed CRID response = %#v", empty)
	}
}

func TestNormalizeCRID(t *testing.T) {
	for input, want := range map[string]string{
		"crid-a": "crid-a", " crid-a ": "crid-a", "$crid-a": "crid-a", " $ crid-a ": "crid-a",
		"$": "", "crid-a$": "crid-a$", "$$crid-a": "$crid-a", "<crid-a>": "<crid-a>",
	} {
		if got := normalizeCRID(input); got != want {
			t.Errorf("normalizeCRID(%q) = %q, want %q", input, got, want)
		}
	}
}
