package gateway

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/layervai/qurl-go/qurl"
)

const (
	maxForwardBodyBytes       int64 = 64 << 20
	mcpSessionIdleTTL               = 15 * time.Minute
	mcpSessionAbsoluteTTL           = 24 * time.Hour
	mcpSessionCleanupInterval       = time.Minute
)

type mcpSession struct {
	crid        string
	portal      Portal
	resourceURL *url.URL
	createdAt   time.Time
	lastUsedAt  time.Time
}

type Gateway struct {
	config    Config
	server    *http.Server
	resolve   LinkResolver
	open      PortalOpener
	transport http.RoundTripper
	sessions  map[string]*mcpSession
	// dynamicSessions are connector-owned MCP sessions opened without a CRID.
	dynamicSessions map[string]*dynamicSession
	sessionsMu      sync.Mutex
	cleanupCtx      context.Context
	stopCleanup     context.CancelFunc
	cleanupOnce     sync.Once
}

// New creates a gateway backed by the qURL share API.
func New(config Config) (*Gateway, error) {
	resolver, err := NewQURLLinkResolver(config, nil)
	if err != nil {
		return nil, err
	}
	opener, err := newQURLPortalOpener(config, resolver.(accessTokenResolver))
	if err != nil {
		return nil, err
	}
	return NewWithResolverAndOpener(config, resolver, opener), nil
}

// NewWithResolver is useful for tests and for applications that already own a
// qURL client. Production callers normally use New.
func NewWithResolver(config Config, resolver LinkResolver) *Gateway {
	opener := qurlPortalOpener{}
	if access, ok := resolver.(accessTokenResolver); ok {
		opener.access = access
	}
	return NewWithResolverAndOpener(config, resolver, opener)
}

// NewWithResolverAndOpener is useful for tests and for applications that supply
// their own qURL portal configuration.
func NewWithResolverAndOpener(config Config, resolver LinkResolver, opener PortalOpener) *Gateway {
	cleanupCtx, stopCleanup := context.WithCancel(context.Background())
	gateway := &Gateway{
		config:          config,
		resolve:         resolver,
		open:            opener,
		transport:       http.DefaultTransport,
		sessions:        make(map[string]*mcpSession),
		dynamicSessions: make(map[string]*dynamicSession),
		cleanupCtx:      cleanupCtx,
		stopCleanup:     stopCleanup,
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", gateway.handleHealth)
	mux.HandleFunc("/mcp", gateway.handleMCP)
	mux.HandleFunc("/", gateway.handleNotFound)
	gateway.server = &http.Server{
		Addr:              config.ListenAddr,
		Handler:           mux,
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       70 * time.Second,
		WriteTimeout:      0,
		IdleTimeout:       120 * time.Second,
	}
	return gateway
}

func (g *Gateway) ListenAndServe() error {
	g.startSessionCleanup()
	defer g.stopCleanup()
	log.Printf("qurl-connector listening on %s", g.config.ListenAddr)
	return g.server.ListenAndServe()
}

func (g *Gateway) Shutdown(ctx context.Context) error {
	g.stopCleanup()
	return g.server.Shutdown(ctx)
}

// Handler exposes the gateway handler for embedding and tests.
func (g *Gateway) Handler() http.Handler { return g.server.Handler }

func (g *Gateway) handleHealth(writer http.ResponseWriter, _ *http.Request) {
	writer.Header().Set("Content-Type", "application/json")
	_, _ = writer.Write([]byte(`{"ok":true}`))
}

func (g *Gateway) handleMCP(writer http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodPost && request.Method != http.MethodGet && request.Method != http.MethodDelete {
		writer.Header().Set("Allow", "POST, GET, DELETE")
		http.Error(writer, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	crid := g.requestCRID(request)
	var body []byte
	if request.Body != nil {
		request.Body = http.MaxBytesReader(writer, request.Body, maxForwardBodyBytes)
		var readErr error
		body, readErr = io.ReadAll(request.Body)
		if readErr != nil {
			http.Error(writer, "failed to read MCP request body", http.StatusBadRequest)
			return
		}
		if crid == "" {
			crid = bodyCRID(body)
		}
	}
	sessionID := strings.TrimSpace(request.Header.Get("Mcp-Session-Id"))
	var (
		portal        Portal
		resourceURL   *url.URL
		createSession bool
	)
	if sessionID != "" {
		if dynamic, ok := g.lookupDynamicSession(sessionID); ok {
			if crid != "" {
				http.Error(writer, "CRID cannot be sent for a dynamic CRID session; pass crid as a tool argument", http.StatusConflict)
				return
			}
			g.serveDynamicSession(writer, request, sessionID, dynamic, body)
			return
		}
		var (
			found       bool
			sessionCRID string
		)
		portal, resourceURL, sessionCRID, found = g.lookupSession(sessionID)
		if !found {
			log.Printf("MCP session %s is unknown or expired; client must re-initialize", redactSessionID(sessionID))
			http.Error(writer, "MCP session not found; re-initialize the MCP connection", http.StatusNotFound)
			return
		}
		if crid != "" && crid != sessionCRID {
			http.Error(writer, "CRID does not match the existing MCP session", http.StatusConflict)
			return
		}
	} else {
		if crid == "" {
			if g.config.DynamicCRID && request.Method == http.MethodPost && isInitializeRequest(body) {
				g.initializeDynamicSession(writer, body)
				return
			}
			http.Error(writer, "missing CRID; send X-MCP-CRID, ?crid=, or a top-level crid field", http.StatusBadRequest)
			return
		}
		var err error
		portal, resourceURL, err = g.openPortal(request.Context(), crid)
		if err != nil {
			g.writePortalError(writer, crid, err)
			return
		}
		createSession = true
	}
	if request.Body != nil {
		request.Body = io.NopCloser(bytes.NewReader(body))
		request.ContentLength = int64(len(body))
		request.GetBody = func() (io.ReadCloser, error) {
			return io.NopCloser(bytes.NewReader(body)), nil
		}
	}
	request.Header.Del(g.config.CRIDHeader)
	request.Header.Del("X-MCP-CRID")
	request.Header.Del("X-QURL-CRID")
	request.Header.Del("X-CRID")
	request.Header.Del("CRID")
	request.URL.RawQuery = removeCRIDQuery(request.URL.Query()).Encode()
	forwardQuery := request.URL.RawQuery
	targetWithQuery := *resourceURL
	targetWithQuery.RawQuery = joinQuery(targetWithQuery.RawQuery, forwardQuery)
	proxy := httputil.NewSingleHostReverseProxy(&targetWithQuery)
	originalHost := request.Host
	proxy.Director = func(req *http.Request) {
		req.URL.Scheme = targetWithQuery.Scheme
		req.URL.Host = targetWithQuery.Host
		req.URL.Path = targetWithQuery.Path
		req.URL.RawPath = targetWithQuery.RawPath
		req.URL.RawQuery = targetWithQuery.RawQuery
		req.Host = targetWithQuery.Host
		req.Header.Set("X-Forwarded-Host", originalHost)
	}
	proxy.Transport = portalTransport{base: g.transport, portal: portal}
	proxy.ModifyResponse = func(response *http.Response) error {
		if response.StatusCode >= http.StatusBadRequest {
			log.Printf("upstream MCP %s returned HTTP %d (%s)", request.Method, response.StatusCode, describeUpstreamResponse(response, nil))
		}
		if createSession && response.StatusCode >= http.StatusOK && response.StatusCode < http.StatusMultipleChoices {
			if upstreamSessionID := strings.TrimSpace(response.Header.Get("Mcp-Session-Id")); upstreamSessionID != "" {
				g.storeSession(upstreamSessionID, crid, portal, resourceURL)
				log.Printf("registered MCP session %s for CRID %s", redactSessionID(upstreamSessionID), redactCRID(crid))
			}
		}
		if sessionID != "" && request.Method == http.MethodDelete && response.StatusCode >= http.StatusOK && response.StatusCode < http.StatusMultipleChoices {
			g.deleteSession(sessionID)
			log.Printf("deleted MCP session %s", redactSessionID(sessionID))
		}
		return nil
	}
	proxy.ErrorHandler = func(w http.ResponseWriter, _ *http.Request, proxyErr error) {
		log.Printf("qURL link proxy failed: %v", proxyErr)
		http.Error(w, "qurl link upstream unavailable", http.StatusBadGateway)
	}
	if sessionID == "" {
		log.Printf("forwarding initial MCP %s via qURL link for CRID %s", request.Method, redactCRID(crid))
	} else {
		log.Printf("forwarding MCP %s via existing session %s", request.Method, redactSessionID(sessionID))
	}
	proxy.ServeHTTP(writer, request)
}

// shareLink mints a qURL access link for the CRID and checks it against the
// configured link policy.
func (g *Gateway) shareLink(ctx context.Context, crid string) (string, error) {
	if g.resolve == nil {
		return "", fmt.Errorf("qURL link resolver is not configured")
	}
	link, err := g.resolve.Share(ctx, crid)
	if err != nil {
		return "", fmt.Errorf("share CRID: %w", err)
	}
	log.Printf("qURL share returned a %s link (host %s) for CRID %s", linkKind(link), linkHost(link), redactCRID(crid))
	if _, err := g.validateLink(link); err != nil {
		return "", fmt.Errorf("validate qURL link: %w", err)
	}
	return link, nil
}

func (g *Gateway) openPortal(ctx context.Context, crid string) (Portal, *url.URL, error) {
	link, err := g.shareLink(ctx, crid)
	if err != nil {
		return nil, nil, err
	}
	if g.open == nil {
		return nil, nil, fmt.Errorf("qURL portal opener is not configured")
	}
	portal, err := g.open.Open(ctx, link, crid)
	if err != nil || portal == nil {
		if err == nil {
			err = fmt.Errorf("portal opener returned no handle")
		}
		return nil, nil, fmt.Errorf("open qURL portal: %w", err)
	}
	resourceURL, err := validateResourceURL(portal.ResourceURL())
	if err != nil {
		return nil, nil, fmt.Errorf("validate portal resource URL: %w", err)
	}
	return portal, resourceURL, nil
}

func (g *Gateway) writePortalError(writer http.ResponseWriter, crid string, err error) {
	log.Printf("qURL portal setup failed for CRID %s: %v", redactCRID(crid), err)
	status, message := portalErrorResponse(err)
	http.Error(writer, message, status)
}

// portalErrorResponse maps an openPortal error to a status and a message that
// does not expose qURL links or portal URLs.
func portalErrorResponse(err error) (int, string) {
	switch {
	case errors.Is(err, qurl.ErrInvalidResourceRequest):
		return http.StatusBadRequest, "invalid CRID"
	case strings.HasPrefix(err.Error(), "share CRID:"):
		return http.StatusBadGateway, "failed to obtain qurl link"
	case strings.HasPrefix(err.Error(), "validate qURL link:"):
		return http.StatusBadGateway, "invalid qurl link"
	case strings.HasPrefix(err.Error(), "validate portal resource URL:"):
		return http.StatusBadGateway, "invalid qurl resource URL"
	default:
		return http.StatusBadGateway, "failed to open qurl portal"
	}
}

func (g *Gateway) lookupSession(sessionID string) (Portal, *url.URL, string, bool) {
	now := time.Now()
	g.sessionsMu.Lock()
	defer g.sessionsMu.Unlock()
	g.purgeExpiredSessionsLocked(now)
	session, ok := g.sessions[sessionID]
	if !ok {
		return nil, nil, "", false
	}
	session.lastUsedAt = now
	resourceURL := *session.resourceURL
	return session.portal, &resourceURL, session.crid, true
}

func (g *Gateway) storeSession(sessionID, crid string, portal Portal, resourceURL *url.URL) {
	now := time.Now()
	resourceURLCopy := *resourceURL
	g.sessionsMu.Lock()
	defer g.sessionsMu.Unlock()
	g.purgeExpiredSessionsLocked(now)
	g.sessions[sessionID] = &mcpSession{
		crid: crid, portal: portal, resourceURL: &resourceURLCopy,
		createdAt: now, lastUsedAt: now,
	}
}

func (g *Gateway) deleteSession(sessionID string) {
	g.sessionsMu.Lock()
	defer g.sessionsMu.Unlock()
	delete(g.sessions, sessionID)
}

func (g *Gateway) startSessionCleanup() {
	g.cleanupOnce.Do(func() {
		go func() {
			ticker := time.NewTicker(mcpSessionCleanupInterval)
			defer ticker.Stop()
			for {
				select {
				case <-g.cleanupCtx.Done():
					return
				case now := <-ticker.C:
					if removed := g.purgeExpiredSessions(now); removed > 0 {
						log.Printf("purged %d expired MCP session(s)", removed)
					}
				}
			}
		}()
	})
}

func (g *Gateway) purgeExpiredSessions(now time.Time) int {
	g.sessionsMu.Lock()
	defer g.sessionsMu.Unlock()
	return g.purgeExpiredSessionsLocked(now)
}

func (g *Gateway) purgeExpiredSessionsLocked(now time.Time) int {
	removed := 0
	for sessionID, session := range g.sessions {
		if now.Sub(session.createdAt) >= mcpSessionAbsoluteTTL || now.Sub(session.lastUsedAt) >= mcpSessionIdleTTL {
			delete(g.sessions, sessionID)
			removed++
		}
	}
	for sessionID, session := range g.dynamicSessions {
		if now.Sub(session.createdAt) >= mcpSessionAbsoluteTTL || now.Sub(session.lastUsedAt) >= mcpSessionIdleTTL {
			delete(g.dynamicSessions, sessionID)
			go g.closeDynamicSession(context.Background(), session)
			removed++
		}
	}
	return removed
}

func bodyCRID(body []byte) string {
	var envelope struct {
		CRID string `json:"crid"`
	}
	if err := json.Unmarshal(body, &envelope); err != nil {
		return ""
	}
	return normalizeCRID(envelope.CRID)
}

// normalizeCRID trims whitespace and one leading dollar sign, so a CRID
// written as "$value" is treated the same as "value".
func normalizeCRID(value string) string {
	value = strings.TrimSpace(value)
	if strings.HasPrefix(value, "$") {
		value = strings.TrimSpace(value[1:])
	}
	return value
}

func (g *Gateway) requestCRID(request *http.Request) string {
	if header := strings.TrimSpace(g.config.CRIDHeader); header != "" {
		if value := normalizeCRID(request.Header.Get(header)); value != "" {
			return value
		}
	}
	for _, header := range []string{"X-MCP-CRID", "X-QURL-CRID", "X-CRID", "CRID"} {
		if value := normalizeCRID(request.Header.Get(header)); value != "" {
			return value
		}
	}
	return normalizeCRID(request.URL.Query().Get("crid"))
}

func (g *Gateway) validateLink(raw string) (*url.URL, error) {
	target, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || (target.Scheme != "http" && target.Scheme != "https") || target.Host == "" || target.User != nil {
		return nil, fmt.Errorf("qurl link must be an absolute http(s) URL")
	}
	if !qurl.IsCredentialLink(raw) {
		if _, ok := accessTokenFromLink(raw); !ok {
			return nil, fmt.Errorf("qurl link does not contain a supported qURL credential")
		}
	}
	if len(g.config.AllowedLinkHosts) > 0 {
		host := strings.ToLower(target.Hostname())
		if _, ok := g.config.AllowedLinkHosts[host]; !ok {
			return nil, fmt.Errorf("qurl link host %q is not allowed", host)
		}
	}
	return target, nil
}

func linkKind(raw string) string {
	if qurl.IsCredentialLink(raw) {
		return "qv2"
	}
	if _, ok := accessTokenFromLink(raw); ok {
		return "access-token"
	}
	return "unknown"
}

func linkHost(raw string) string {
	link, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || link.Hostname() == "" {
		return "[invalid]"
	}
	return link.Hostname()
}

func (g *Gateway) handleNotFound(writer http.ResponseWriter, _ *http.Request) {
	http.NotFound(writer, nil)
}

func removeCRIDQuery(values url.Values) url.Values {
	values.Del("crid")
	return values
}

func joinQuery(linkQuery, requestQuery string) string {
	if linkQuery == "" {
		return requestQuery
	}
	if requestQuery == "" {
		return linkQuery
	}
	return linkQuery + "&" + requestQuery
}

func redactCRID(value string) string {
	value = strings.TrimSpace(value)
	if len(value) <= 12 {
		return "[redacted]"
	}
	return value[:6] + "..." + value[len(value)-6:]
}

func redactSessionID(value string) string {
	value = strings.TrimSpace(value)
	if len(value) <= 12 {
		return "[redacted]"
	}
	return value[:6] + "..." + value[len(value)-6:]
}

func validateResourceURL(raw string) (*url.URL, error) {
	target, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || target.Scheme != "https" || target.Host == "" || target.User != nil || target.Fragment != "" {
		return nil, fmt.Errorf("portal resource URL must be an absolute HTTPS URL without credentials or fragment")
	}
	return target, nil
}

type Portal interface {
	ResourceURL() string
	AuthorizeContentRequest(*http.Request) error
	CheckContentRedirect(*http.Request, []*http.Request) error
}

type PortalOpener interface {
	Open(context.Context, string, string) (Portal, error)
}

type qurlPortalOpener struct {
	access accessTokenResolver
	config *qurl.Config
}

func newQURLPortalOpener(config Config, access accessTokenResolver) (qurlPortalOpener, error) {
	opener := qurlPortalOpener{access: access}
	if config.DeploymentPath == "" {
		return opener, nil
	}
	portalConfig, err := loadPortalConfig(config.DeploymentPath)
	if err != nil {
		return qurlPortalOpener{}, err
	}
	opener.config = portalConfig
	return opener, nil
}

func (o qurlPortalOpener) Open(ctx context.Context, link, crid string) (Portal, error) {
	if token, ok := accessTokenFromLink(link); ok {
		if o.access == nil {
			return nil, fmt.Errorf("qurl access-token resolver is not configured")
		}
		resourceURL, err := o.access.ResolveAccessToken(ctx, token)
		if err != nil {
			return nil, err
		}
		return resolvedPortal{resourceURL: resourceURL}, nil
	}
	var (
		handle *qurl.ResourceHandle
		err    error
	)
	if o.config == nil {
		handle, err = qurl.EnterPortalForCRID(ctx, link, crid)
	} else {
		portalConfig := *o.config
		portalConfig.ExpectedCRID = crid
		handle, err = qurl.EnterPortalWith(ctx, link, portalConfig)
	}
	if err != nil {
		return nil, err
	}
	return qurlPortal{handle: handle}, nil
}

// resolvedPortal represents an access granted by /v1/resolve. Unlike a qv2
// portal, the headless API has already granted the caller's IP access and does
// not issue a session cookie that must be attached to content requests.
type resolvedPortal struct{ resourceURL string }

func (p resolvedPortal) ResourceURL() string { return p.resourceURL }

func (p resolvedPortal) AuthorizeContentRequest(request *http.Request) error {
	return p.checkOrigin(request)
}

func (p resolvedPortal) CheckContentRedirect(request *http.Request, _ []*http.Request) error {
	return p.checkOrigin(request)
}

func (p resolvedPortal) checkOrigin(request *http.Request) error {
	resource, err := validateResourceURL(p.resourceURL)
	if err != nil || request == nil || request.URL == nil {
		return fmt.Errorf("qurl: invalid resolved content request")
	}
	if request.URL.Scheme != resource.Scheme || request.URL.Host != resource.Host {
		return fmt.Errorf("qurl: resolved content request origin changed")
	}
	return nil
}

type qurlPortal struct{ handle *qurl.ResourceHandle }

func (p qurlPortal) ResourceURL() string {
	return p.handle.ResourceURL
}

func (p qurlPortal) AuthorizeContentRequest(request *http.Request) error {
	return p.handle.AuthorizeContentRequest(request)
}

func (p qurlPortal) CheckContentRedirect(request *http.Request, via []*http.Request) error {
	return p.handle.CheckContentRedirect(request, via)
}

type portalTransport struct {
	base   http.RoundTripper
	portal Portal
}

func (t portalTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	if err := t.portal.AuthorizeContentRequest(request); err != nil {
		return nil, err
	}
	// ReverseProxy receives a server request; client transports reject a
	// non-empty RequestURI field.
	request.RequestURI = ""
	client := &http.Client{
		Transport: t.base,
		CheckRedirect: func(next *http.Request, via []*http.Request) error {
			// qURL resource portals commonly redirect from a capability path to
			// the MCP path without spelling out a query. Keep the caller's
			// non-CRID query parameters across that path-only redirect.
			if len(via) > 0 && next.URL.RawQuery == "" {
				next.URL.RawQuery = via[len(via)-1].URL.RawQuery
			}
			return t.portal.CheckContentRedirect(next, via)
		},
	}
	response, err := client.Do(request)
	if err != nil {
		if response != nil && response.Body != nil {
			_ = response.Body.Close()
		}
		return nil, err
	}
	return response, nil
}
