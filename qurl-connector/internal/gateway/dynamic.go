package gateway

import (
	"bufio"
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"mime"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// Dynamic CRID mode lets an MCP client connect without configuring a CRID. The
// connector then acts as an MCP server itself and exposes meta-tools whose
// arguments carry the CRID. qurl_get_link only shares the CRID and returns the
// access link, which also serves protected HTTP services. For each CRID used
// with the MCP meta-tools, the connector shares the CRID, opens the qURL
// portal, and keeps one MCP client session with the protected backend MCP
// server.

const (
	dynamicListToolsName          = "qurl_list_tools"
	dynamicCallToolName           = "qurl_call_tool"
	dynamicGetLinkName            = "qurl_get_link"
	connectorName                 = "qurl-connector"
	connectorVersion              = "0.1.0"
	defaultMCPProtocolVersion     = "2025-06-18"
	maxDynamicBackendsPerSession  = 32
	backendCloseTimeout           = 10 * time.Second
	jsonRPCParseError             = -32700
	jsonRPCInvalidRequest         = -32600
	jsonRPCMethodNotFound         = -32601
	jsonRPCInvalidParams          = -32602
	dynamicSessionInstructionText = "This connector reaches qURL-protected HTTP services and MCP servers by CRID. " +
		"Users may give a CRID without naming it, by prefixing it with a dollar sign: treat a value written " +
		"as $value as the CRID and pass value as the crid argument. " +
		"Use " + dynamicListToolsName + " and " + dynamicCallToolName + " only when the user explicitly wants to use " +
		"the CRID as an MCP server: to list or call its tools, or to have it perform an operation. Call " +
		dynamicListToolsName + " with a CRID to discover the tools of that MCP server, then call " +
		dynamicCallToolName + " with the same CRID, the tool name, and the tool arguments. " +
		"In every other case, including when the user asks for a qURL link, an access link, or to open or view the CRID, " +
		"call " + dynamicGetLinkName + " and give the returned link to the user. " +
		"If an MCP meta-tool reports that the CRID may not be an MCP server, call " + dynamicGetLinkName + " instead."
	dynamicCRIDDescription = "CRID of the qURL-protected resource. A value the user wrote with a leading dollar sign, " +
		"such as $value, is a CRID even when the user does not call it one; pass it with or without the dollar sign."
	dynamicListToolsDescription = "Create qURL access for the CRID and list the tools exposed by that protected MCP server. " +
		"Use this only when the user explicitly wants the tools of $value or wants $value to perform an operation; " +
		"for a link to $value use " + dynamicGetLinkName + "."
	dynamicCallToolDescription = "Create qURL access for the CRID if needed and call one tool on that protected MCP server. " +
		"The user may name the server as $value; pass value as crid."
	dynamicGetLinkDescription = "Mint a short-lived qURL access link for the CRID and return it, without calling any MCP server. " +
		"Use this when the user asks for a qURL link or an access link to $value, wants to open or view $value, " +
		"or does not explicitly ask to use $value as an MCP server. Works for protected HTTP services and MCP servers. " +
		"Each call mints a new link; anyone holding the link can open the resource until it expires."
	backendNotMCPHint = "the CRID may not be an MCP server; if the user wants to open or share it, call " +
		dynamicGetLinkName + " to get a qURL link instead"
)

var supportedMCPProtocolVersions = map[string]struct{}{
	"2025-11-25": {}, "2025-06-18": {}, "2025-03-26": {}, "2024-11-05": {},
}

type jsonRPCMessage struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Method  string          `json:"method,omitempty"`
	Params  json.RawMessage `json:"params,omitempty"`
	Result  json.RawMessage `json:"result,omitempty"`
	Error   *jsonRPCError   `json:"error,omitempty"`
}

type jsonRPCError struct {
	Code    int             `json:"code"`
	Message string          `json:"message"`
	Data    json.RawMessage `json:"data,omitempty"`
}

type jsonRPCResponse struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Result  any             `json:"result,omitempty"`
	Error   *jsonRPCError   `json:"error,omitempty"`
}

// dynamicSession is a connector-owned MCP session. createdAt and lastUsedAt
// are guarded by Gateway.sessionsMu; backends is guarded by mu.
type dynamicSession struct {
	protocolVersion string
	createdAt       time.Time
	lastUsedAt      time.Time
	mu              sync.Mutex
	closed          bool
	backends        map[string]*dynamicBackend
}

// dynamicBackend is the connector's MCP client session with one protected MCP
// server. mu serializes initialization; requests run concurrently on a
// snapshot of the established connection. The qURL portal is kept when only
// the backend MCP session has to be renewed.
type dynamicBackend struct {
	crid        string
	mu          sync.Mutex
	portal      Portal
	resourceURL *url.URL
	conn        *backendConn
	nextID      atomic.Int64
}

type backendConn struct {
	portal          Portal
	resourceURL     *url.URL
	sessionID       string
	protocolVersion string
}

// backendError carries a message that is safe to return to the MCP client.
// The wrapped error may contain portal URLs and is only logged.
type backendError struct {
	public string
	err    error
}

func (e *backendError) Error() string { return e.public + ": " + e.err.Error() }

func (e *backendError) Unwrap() error { return e.err }

type backendStatusError struct {
	status int
	detail string
}

func (e *backendStatusError) Error() string {
	message := fmt.Sprintf("backend MCP server returned HTTP %d", e.status)
	if e.detail != "" {
		message += " (" + e.detail + ")"
	}
	return message
}

// describeUpstreamResponse summarizes a failed upstream response for logs: the
// final request path after redirects (without query), the redirect count, the
// Server and Content-Type headers, and the start of the body.
func describeUpstreamResponse(response *http.Response, body []byte) string {
	parts := []string{}
	if response.Request != nil && response.Request.URL != nil {
		parts = append(parts, fmt.Sprintf("final %s %s%s", response.Request.Method, response.Request.URL.Host, response.Request.URL.EscapedPath()))
		redirects := 0
		for previous := response.Request.Response; previous != nil && previous.Request != nil; previous = previous.Request.Response {
			redirects++
		}
		parts = append(parts, fmt.Sprintf("redirects=%d", redirects))
	}
	for _, header := range []string{"Server", "Content-Type", "Location"} {
		if value := response.Header.Get(header); value != "" {
			parts = append(parts, fmt.Sprintf("%s=%q", strings.ToLower(header), value))
		}
	}
	if snippet := strings.TrimSpace(string(body)); snippet != "" {
		parts = append(parts, fmt.Sprintf("body=%q", snippet))
	}
	return strings.Join(parts, " ")
}

func isInitializeRequest(body []byte) bool {
	var message jsonRPCMessage
	return json.Unmarshal(body, &message) == nil && message.Method == "initialize" && len(message.ID) > 0
}

func (g *Gateway) initializeDynamicSession(writer http.ResponseWriter, body []byte) {
	var message jsonRPCMessage
	if err := json.Unmarshal(body, &message); err != nil {
		writeJSONRPC(writer, nil, nil, &jsonRPCError{Code: jsonRPCParseError, Message: "invalid JSON-RPC message"})
		return
	}
	var params struct {
		ProtocolVersion string `json:"protocolVersion"`
	}
	_ = json.Unmarshal(message.Params, &params)
	protocolVersion := defaultMCPProtocolVersion
	if _, ok := supportedMCPProtocolVersions[params.ProtocolVersion]; ok {
		protocolVersion = params.ProtocolVersion
	}
	sessionID, err := newSessionID()
	if err != nil {
		log.Printf("generate dynamic MCP session ID: %v", err)
		http.Error(writer, "failed to create MCP session", http.StatusInternalServerError)
		return
	}
	now := time.Now()
	session := &dynamicSession{
		protocolVersion: protocolVersion, createdAt: now, lastUsedAt: now,
		backends: make(map[string]*dynamicBackend),
	}
	g.sessionsMu.Lock()
	g.purgeExpiredSessionsLocked(now)
	g.dynamicSessions[sessionID] = session
	g.sessionsMu.Unlock()
	log.Printf("registered dynamic CRID MCP session %s", redactSessionID(sessionID))
	writer.Header().Set("Mcp-Session-Id", sessionID)
	writeJSONRPC(writer, message.ID, map[string]any{
		"protocolVersion": protocolVersion,
		"capabilities":    map[string]any{"tools": map[string]any{"listChanged": false}},
		"serverInfo":      map[string]any{"name": connectorName, "version": connectorVersion},
		"instructions":    dynamicSessionInstructionText,
	}, nil)
}

func (g *Gateway) lookupDynamicSession(sessionID string) (*dynamicSession, bool) {
	now := time.Now()
	g.sessionsMu.Lock()
	defer g.sessionsMu.Unlock()
	g.purgeExpiredSessionsLocked(now)
	session, ok := g.dynamicSessions[sessionID]
	if ok {
		session.lastUsedAt = now
	}
	return session, ok
}

func (g *Gateway) serveDynamicSession(writer http.ResponseWriter, request *http.Request, sessionID string, session *dynamicSession, body []byte) {
	switch request.Method {
	case http.MethodDelete:
		g.sessionsMu.Lock()
		delete(g.dynamicSessions, sessionID)
		g.sessionsMu.Unlock()
		g.closeDynamicSession(request.Context(), session)
		log.Printf("deleted dynamic CRID MCP session %s", redactSessionID(sessionID))
		writer.WriteHeader(http.StatusOK)
		return
	case http.MethodGet:
		// The connector does not originate server-to-client messages, so it
		// offers no standalone SSE stream for its own sessions.
		writer.Header().Set("Allow", "POST, DELETE")
		http.Error(writer, "SSE stream not offered for dynamic CRID sessions", http.StatusMethodNotAllowed)
		return
	}
	trimmed := bytes.TrimSpace(body)
	if len(trimmed) > 0 && trimmed[0] == '[' {
		writeJSONRPC(writer, nil, nil, &jsonRPCError{Code: jsonRPCInvalidRequest, Message: "JSON-RPC batches are not supported"})
		return
	}
	var message jsonRPCMessage
	if err := json.Unmarshal(trimmed, &message); err != nil {
		writeJSONRPC(writer, nil, nil, &jsonRPCError{Code: jsonRPCParseError, Message: "invalid JSON-RPC message"})
		return
	}
	if message.Method == "" || len(message.ID) == 0 {
		// Notifications (for example notifications/initialized) and client
		// responses need no reply.
		writer.WriteHeader(http.StatusAccepted)
		return
	}
	result, rpcErr := g.dispatchDynamic(request.Context(), session, message)
	writeJSONRPC(writer, message.ID, result, rpcErr)
}

func (g *Gateway) dispatchDynamic(ctx context.Context, session *dynamicSession, message jsonRPCMessage) (any, *jsonRPCError) {
	switch message.Method {
	case "ping":
		return map[string]any{}, nil
	case "initialize":
		return nil, &jsonRPCError{Code: jsonRPCInvalidRequest, Message: "MCP session is already initialized"}
	case "tools/list":
		return map[string]any{"tools": dynamicToolDefinitions()}, nil
	case "tools/call":
		var params struct {
			Name      string          `json:"name"`
			Arguments json.RawMessage `json:"arguments"`
		}
		if err := json.Unmarshal(message.Params, &params); err != nil {
			return nil, &jsonRPCError{Code: jsonRPCInvalidParams, Message: "invalid tools/call params"}
		}
		switch params.Name {
		case dynamicListToolsName:
			return g.callDynamicListTools(ctx, session, params.Arguments)
		case dynamicCallToolName:
			return g.callDynamicCallTool(ctx, session, params.Arguments)
		case dynamicGetLinkName:
			return g.callDynamicGetLink(ctx, params.Arguments)
		default:
			return nil, &jsonRPCError{Code: jsonRPCInvalidParams, Message: fmt.Sprintf("unknown tool %q", params.Name)}
		}
	default:
		return nil, &jsonRPCError{Code: jsonRPCMethodNotFound, Message: fmt.Sprintf("method %q is not supported", message.Method)}
	}
}

func dynamicToolDefinitions() []map[string]any {
	cridProperty := map[string]any{
		"type":        "string",
		"description": dynamicCRIDDescription,
	}
	return []map[string]any{
		{
			"name":        dynamicListToolsName,
			"title":       "List tools of a qURL-protected MCP server",
			"description": dynamicListToolsDescription,
			"inputSchema": map[string]any{
				"type": "object",
				"properties": map[string]any{
					"crid":   cridProperty,
					"cursor": map[string]any{"type": "string", "description": "Pagination cursor returned as nextCursor."},
				},
				"required":             []string{"crid"},
				"additionalProperties": false,
			},
		},
		{
			"name":        dynamicCallToolName,
			"title":       "Call a tool on a qURL-protected MCP server",
			"description": dynamicCallToolDescription,
			"inputSchema": map[string]any{
				"type": "object",
				"properties": map[string]any{
					"crid":      cridProperty,
					"name":      map[string]any{"type": "string", "description": "Tool name returned by " + dynamicListToolsName + "."},
					"arguments": map[string]any{"type": "object", "description": "Arguments for the backend tool."},
				},
				"required":             []string{"crid", "name"},
				"additionalProperties": false,
			},
		},
		{
			"name":        dynamicGetLinkName,
			"title":       "Get a qURL access link",
			"description": dynamicGetLinkDescription,
			"inputSchema": map[string]any{
				"type":                 "object",
				"properties":           map[string]any{"crid": cridProperty},
				"required":             []string{"crid"},
				"additionalProperties": false,
			},
		},
	}
}

// callDynamicGetLink shares the CRID and returns the qURL link without opening
// a portal or a backend session, so it works for HTTP services too.
func (g *Gateway) callDynamicGetLink(ctx context.Context, raw json.RawMessage) (any, *jsonRPCError) {
	var args struct {
		CRID string `json:"crid"`
	}
	if err := decodeToolArguments(raw, &args); err != nil {
		return nil, &jsonRPCError{Code: jsonRPCInvalidParams, Message: err.Error()}
	}
	crid := normalizeCRID(args.CRID)
	if crid == "" {
		return nil, &jsonRPCError{Code: jsonRPCInvalidParams, Message: "crid is required"}
	}
	link, err := g.shareLink(ctx, crid)
	if err != nil {
		return toolErrorResult(publicBackendError(crid, err)), nil
	}
	structured := map[string]any{"crid": crid, "link": link}
	return map[string]any{
		"content":           []map[string]any{{"type": "text", "text": link}},
		"structuredContent": structured,
	}, nil
}

func (g *Gateway) callDynamicListTools(ctx context.Context, session *dynamicSession, raw json.RawMessage) (any, *jsonRPCError) {
	var args struct {
		CRID   string `json:"crid"`
		Cursor string `json:"cursor"`
	}
	if err := decodeToolArguments(raw, &args); err != nil {
		return nil, &jsonRPCError{Code: jsonRPCInvalidParams, Message: err.Error()}
	}
	crid := normalizeCRID(args.CRID)
	if crid == "" {
		return nil, &jsonRPCError{Code: jsonRPCInvalidParams, Message: "crid is required"}
	}
	var params any
	if args.Cursor != "" {
		params = map[string]any{"cursor": args.Cursor}
	}
	response, err := g.backendRequest(ctx, session, crid, "tools/list", params)
	if err != nil {
		return toolErrorResult(publicBackendError(crid, err)), nil
	}
	if response.Error != nil {
		return toolErrorResult(fmt.Sprintf("backend MCP error %d: %s", response.Error.Code, response.Error.Message)), nil
	}
	var listed struct {
		Tools      []json.RawMessage `json:"tools"`
		NextCursor string            `json:"nextCursor,omitempty"`
	}
	if err := json.Unmarshal(response.Result, &listed); err != nil {
		return toolErrorResult("backend MCP server returned an invalid tools/list result"), nil
	}
	if listed.Tools == nil {
		listed.Tools = []json.RawMessage{}
	}
	structured := map[string]any{"crid": crid, "tools": listed.Tools}
	if listed.NextCursor != "" {
		structured["nextCursor"] = listed.NextCursor
	}
	text, err := json.Marshal(structured)
	if err != nil {
		return toolErrorResult("failed to encode backend tools"), nil
	}
	return map[string]any{
		"content":           []map[string]any{{"type": "text", "text": string(text)}},
		"structuredContent": structured,
	}, nil
}

func (g *Gateway) callDynamicCallTool(ctx context.Context, session *dynamicSession, raw json.RawMessage) (any, *jsonRPCError) {
	var args struct {
		CRID      string          `json:"crid"`
		Name      string          `json:"name"`
		Arguments json.RawMessage `json:"arguments"`
	}
	if err := decodeToolArguments(raw, &args); err != nil {
		return nil, &jsonRPCError{Code: jsonRPCInvalidParams, Message: err.Error()}
	}
	crid := normalizeCRID(args.CRID)
	if crid == "" || strings.TrimSpace(args.Name) == "" {
		return nil, &jsonRPCError{Code: jsonRPCInvalidParams, Message: "crid and name are required"}
	}
	arguments := args.Arguments
	if len(bytes.TrimSpace(arguments)) == 0 || bytes.Equal(bytes.TrimSpace(arguments), []byte("null")) {
		arguments = json.RawMessage(`{}`)
	} else if bytes.TrimSpace(arguments)[0] != '{' {
		return nil, &jsonRPCError{Code: jsonRPCInvalidParams, Message: "arguments must be an object"}
	}
	response, err := g.backendRequest(ctx, session, crid, "tools/call", map[string]any{
		"name": args.Name, "arguments": arguments,
	})
	if err != nil {
		return toolErrorResult(publicBackendError(crid, err)), nil
	}
	if response.Error != nil {
		return toolErrorResult(fmt.Sprintf("backend MCP error %d: %s", response.Error.Code, response.Error.Message)), nil
	}
	if len(response.Result) == 0 {
		return toolErrorResult("backend MCP server returned an empty tools/call result"), nil
	}
	// The backend result is already a CallToolResult; return it unchanged.
	return response.Result, nil
}

func decodeToolArguments(raw json.RawMessage, target any) error {
	if len(bytes.TrimSpace(raw)) == 0 {
		raw = json.RawMessage(`{}`)
	}
	if err := json.Unmarshal(raw, target); err != nil {
		return fmt.Errorf("invalid tool arguments")
	}
	return nil
}

func toolErrorResult(message string) map[string]any {
	return map[string]any{
		"content": []map[string]any{{"type": "text", "text": message}},
		"isError": true,
	}
}

func publicBackendError(crid string, err error) string {
	log.Printf("dynamic CRID request failed for CRID %s: %v", redactCRID(crid), err)
	var public *backendError
	if errors.As(err, &public) {
		return public.public
	}
	_, message := portalErrorResponse(err)
	return message
}

// backendRequest sends one JSON-RPC request to the backend MCP server for the
// CRID, initializing qURL access and the backend MCP session on first use. It
// retries once: after HTTP 404 (expired backend session) with a new backend
// session, and after HTTP 401/403 (rejected portal authorization) with a new
// qURL share.
func (g *Gateway) backendRequest(ctx context.Context, session *dynamicSession, crid, method string, params any) (*jsonRPCMessage, error) {
	backend, err := session.backend(crid)
	if err != nil {
		return nil, err
	}
	for attempt := 0; ; attempt++ {
		conn, err := g.ensureBackend(ctx, session, backend)
		if err != nil {
			return nil, err
		}
		response, _, err := g.backendPost(ctx, conn, backend.newRequest(method, params))
		var status *backendStatusError
		if attempt == 0 && errors.As(err, &status) {
			switch {
			case status.status == http.StatusNotFound && conn.sessionID != "":
				log.Printf("backend MCP session for CRID %s expired; re-initializing", redactCRID(crid))
				backend.reset(conn, false)
				continue
			case status.status == http.StatusUnauthorized || status.status == http.StatusForbidden:
				log.Printf("qURL portal for CRID %s was rejected; sharing again", redactCRID(crid))
				backend.reset(conn, true)
				continue
			}
		}
		if err != nil {
			return nil, &backendError{public: "backend MCP request failed", err: err}
		}
		return response, nil
	}
}

func (s *dynamicSession) backend(crid string) (*dynamicBackend, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return nil, &backendError{public: "MCP session is closed", err: errors.New("dynamic session closed")}
	}
	if backend, ok := s.backends[crid]; ok {
		return backend, nil
	}
	if len(s.backends) >= maxDynamicBackendsPerSession {
		return nil, &backendError{
			public: fmt.Sprintf("too many CRIDs in this MCP session (limit %d)", maxDynamicBackendsPerSession),
			err:    errors.New("dynamic backend limit reached"),
		}
	}
	backend := &dynamicBackend{crid: crid}
	s.backends[crid] = backend
	return backend, nil
}

func (g *Gateway) ensureBackend(ctx context.Context, session *dynamicSession, backend *dynamicBackend) (*backendConn, error) {
	backend.mu.Lock()
	defer backend.mu.Unlock()
	if backend.conn != nil {
		return backend.conn, nil
	}
	if backend.portal == nil {
		portal, resourceURL, err := g.openPortal(ctx, backend.crid)
		if err != nil {
			return nil, err
		}
		backend.portal, backend.resourceURL = portal, resourceURL
	}
	conn := &backendConn{portal: backend.portal, resourceURL: backend.resourceURL, protocolVersion: session.protocolVersion}
	response, sessionID, err := g.backendPost(ctx, conn, backend.newRequest("initialize", map[string]any{
		"protocolVersion": session.protocolVersion,
		"capabilities":    map[string]any{},
		"clientInfo":      map[string]any{"name": connectorName, "version": connectorVersion},
	}))
	if err != nil {
		return nil, &backendError{public: "failed to initialize backend MCP session: " + backendNotMCPHint, err: err}
	}
	if response.Error != nil {
		return nil, &backendError{
			public: fmt.Sprintf("backend MCP initialize error %d: %s", response.Error.Code, response.Error.Message),
			err:    errors.New("backend rejected initialize"),
		}
	}
	var initialized struct {
		ProtocolVersion string `json:"protocolVersion"`
	}
	if err := json.Unmarshal(response.Result, &initialized); err == nil && initialized.ProtocolVersion != "" {
		conn.protocolVersion = initialized.ProtocolVersion
	}
	conn.sessionID = sessionID
	if _, _, err := g.backendPost(ctx, conn, jsonRPCMessage{JSONRPC: "2.0", Method: "notifications/initialized"}); err != nil {
		return nil, &backendError{public: "failed to complete backend MCP initialization", err: err}
	}
	log.Printf("initialized backend MCP session %s for CRID %s", redactSessionID(sessionID), redactCRID(backend.crid))
	backend.conn = conn
	return conn, nil
}

func (b *dynamicBackend) newRequest(method string, params any) jsonRPCMessage {
	message := jsonRPCMessage{
		JSONRPC: "2.0", Method: method,
		ID: json.RawMessage(strconv.FormatInt(b.nextID.Add(1), 10)),
	}
	if params != nil {
		encoded, err := json.Marshal(params)
		if err == nil {
			message.Params = encoded
		}
	}
	return message
}

// reset discards conn if it is still the current connection, so that only one
// concurrent caller re-initializes an expired backend session. dropPortal also
// discards the qURL portal so the next request shares the CRID again.
func (b *dynamicBackend) reset(conn *backendConn, dropPortal bool) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.conn == conn {
		b.conn = nil
		if dropPortal {
			b.portal, b.resourceURL = nil, nil
		}
	}
}

// backendPost sends one JSON-RPC message through the qURL portal. For requests
// it returns the matching response, read from either a JSON body or an SSE
// stream, together with the Mcp-Session-Id response header.
func (g *Gateway) backendPost(ctx context.Context, conn *backendConn, message jsonRPCMessage) (*jsonRPCMessage, string, error) {
	payload, err := json.Marshal(message)
	if err != nil {
		return nil, "", fmt.Errorf("encode backend MCP request: %w", err)
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, conn.resourceURL.String(), bytes.NewReader(payload))
	if err != nil {
		return nil, "", fmt.Errorf("create backend MCP request: %w", err)
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Accept", "application/json, text/event-stream")
	g.setBackendSessionHeaders(request, conn)
	response, err := (portalTransport{base: g.transport, portal: conn.portal}).RoundTrip(request)
	if err != nil {
		return nil, "", fmt.Errorf("send backend MCP %s: %w", messageLabel(message), err)
	}
	defer response.Body.Close()
	if response.StatusCode < http.StatusOK || response.StatusCode >= http.StatusMultipleChoices {
		snippet, _ := io.ReadAll(io.LimitReader(response.Body, 512))
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 64<<10))
		return nil, "", &backendStatusError{
			status: response.StatusCode,
			detail: messageLabel(message) + "; " + describeUpstreamResponse(response, snippet),
		}
	}
	sessionID := strings.TrimSpace(response.Header.Get("Mcp-Session-Id"))
	if len(message.ID) == 0 {
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 64<<10))
		return nil, sessionID, nil
	}
	mediaType, _, _ := mime.ParseMediaType(response.Header.Get("Content-Type"))
	var reply *jsonRPCMessage
	if mediaType == "text/event-stream" {
		reply, err = readSSEResponse(response.Body, message.ID)
	} else {
		reply, err = readJSONResponse(response.Body, message.ID)
	}
	if err != nil {
		return nil, "", fmt.Errorf("read backend MCP %s response: %w", message.Method, err)
	}
	return reply, sessionID, nil
}

func (g *Gateway) setBackendSessionHeaders(request *http.Request, conn *backendConn) {
	if conn.sessionID != "" {
		request.Header.Set("Mcp-Session-Id", conn.sessionID)
	}
	if conn.protocolVersion != "" && conn.sessionID != "" {
		request.Header.Set("MCP-Protocol-Version", conn.protocolVersion)
	}
}

func messageLabel(message jsonRPCMessage) string {
	if message.Method != "" {
		return message.Method
	}
	return "message"
}

func readJSONResponse(body io.Reader, id json.RawMessage) (*jsonRPCMessage, error) {
	contents, err := io.ReadAll(io.LimitReader(body, maxForwardBodyBytes))
	if err != nil {
		return nil, err
	}
	if reply, ok := matchResponse(contents, id); ok {
		return reply, nil
	}
	return nil, errors.New("response is not a JSON-RPC response for the request")
}

func readSSEResponse(body io.Reader, id json.RawMessage) (*jsonRPCMessage, error) {
	reader := bufio.NewReader(io.LimitReader(body, maxForwardBodyBytes))
	var data strings.Builder
	for {
		line, readErr := reader.ReadString('\n')
		line = strings.TrimRight(line, "\r\n")
		switch {
		case strings.HasPrefix(line, "data:"):
			if data.Len() > 0 {
				data.WriteByte('\n')
			}
			data.WriteString(strings.TrimPrefix(strings.TrimPrefix(line, "data:"), " "))
		case line == "" && data.Len() > 0:
			// Progress notifications and server requests are skipped; only
			// the response to this request ends the exchange.
			if reply, ok := matchResponse([]byte(data.String()), id); ok {
				return reply, nil
			}
			data.Reset()
		}
		if readErr != nil {
			if data.Len() > 0 {
				if reply, ok := matchResponse([]byte(data.String()), id); ok {
					return reply, nil
				}
			}
			if errors.Is(readErr, io.EOF) {
				return nil, errors.New("SSE stream ended without a response")
			}
			return nil, readErr
		}
	}
}

func matchResponse(contents []byte, id json.RawMessage) (*jsonRPCMessage, bool) {
	var reply jsonRPCMessage
	if err := json.Unmarshal(contents, &reply); err != nil {
		return nil, false
	}
	if reply.Method != "" || (reply.Result == nil && reply.Error == nil) {
		return nil, false
	}
	if !bytes.Equal(bytes.TrimSpace(reply.ID), bytes.TrimSpace(id)) {
		return nil, false
	}
	return &reply, true
}

// closeDynamicSession terminates every backend MCP session opened for the
// dynamic session. Failures are logged; the backend sessions also expire.
func (g *Gateway) closeDynamicSession(ctx context.Context, session *dynamicSession) {
	session.mu.Lock()
	session.closed = true
	backends := session.backends
	session.backends = map[string]*dynamicBackend{}
	session.mu.Unlock()
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), backendCloseTimeout)
	defer cancel()
	for _, backend := range backends {
		backend.mu.Lock()
		conn := backend.conn
		backend.conn, backend.portal, backend.resourceURL = nil, nil, nil
		backend.mu.Unlock()
		if conn == nil || conn.sessionID == "" {
			continue
		}
		if err := g.deleteBackendSession(ctx, conn); err != nil {
			log.Printf("close backend MCP session for CRID %s: %v", redactCRID(backend.crid), err)
		}
	}
}

func (g *Gateway) deleteBackendSession(ctx context.Context, conn *backendConn) error {
	request, err := http.NewRequestWithContext(ctx, http.MethodDelete, conn.resourceURL.String(), nil)
	if err != nil {
		return err
	}
	g.setBackendSessionHeaders(request, conn)
	response, err := (portalTransport{base: g.transport, portal: conn.portal}).RoundTrip(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 64<<10))
	// 405 means the backend does not support client-initiated termination.
	if response.StatusCode == http.StatusMethodNotAllowed || response.StatusCode == http.StatusNotFound {
		return nil
	}
	if response.StatusCode < http.StatusOK || response.StatusCode >= http.StatusMultipleChoices {
		return &backendStatusError{status: response.StatusCode}
	}
	return nil
}

func writeJSONRPC(writer http.ResponseWriter, id json.RawMessage, result any, rpcErr *jsonRPCError) {
	if len(id) == 0 {
		id = json.RawMessage("null")
	}
	response := jsonRPCResponse{JSONRPC: "2.0", ID: id, Error: rpcErr}
	if rpcErr == nil {
		response.Result = result
	}
	writer.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(writer).Encode(response); err != nil {
		log.Printf("write JSON-RPC response: %v", err)
	}
}

func newSessionID() (string, error) {
	var raw [24]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return "", err
	}
	return "qc_" + hex.EncodeToString(raw[:]), nil
}
