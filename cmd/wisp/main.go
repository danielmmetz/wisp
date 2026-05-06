// wisp is the wisp signaling and static-asset server. Single binary;
// see docs/proposal.md for the architecture.
package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"flag"
	"fmt"
	iofs "io/fs"
	"log/slog"
	"mime"
	"net/http"
	"os"
	"os/signal"
	"path"
	"strings"
	"syscall"
	"time"

	"github.com/danielmmetz/wisp/internal/ratelimit"
	"github.com/danielmmetz/wisp/internal/signaling"
	"github.com/danielmmetz/wisp/internal/turnauth"
	"github.com/peterbourgon/ff/v3"
	"golang.org/x/sync/errgroup"
	"golang.org/x/time/rate"
)

func main() {
	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer cancel()
	logger := slog.New(slog.NewJSONHandler(os.Stderr, nil))
	if err := mainE(ctx, logger); err != nil {
		logger.ErrorContext(ctx, "exiting with error", slog.Any("err", err))
		// Only exit non-zero if our initial context has yet to be canceled.
		// Otherwise it's very likely that the error we're seeing is a result of our attempt at graceful shutdown.
		if ctx.Err() == nil {
			os.Exit(1)
		}
	}
}

func mainE(ctx context.Context, logger *slog.Logger) error {
	fs := flag.NewFlagSet("wisp", flag.ContinueOnError)
	var (
		addr             string
		maxRooms         int
		maxPeersPerRoom  int
		createPerMin     float64
		createBurst      int
		joinPerMin       float64
		joinBurst        int
		trustXFF         bool
		cfTurnKeyID      string
		cfTurnAPIToken   string
		cfTurnTTLSeconds int
	)
	fs.StringVar(&addr, "addr", ":8080", "listen address")
	fs.IntVar(&maxRooms, "max-rooms", 1000, "global cap on concurrent rooms (0 disables)")
	fs.IntVar(&maxPeersPerRoom, "max-peers-per-room", 6, "hard cap on peers per room")
	fs.Float64Var(&createPerMin, "create-per-min", 10, "create_room attempts per minute per IP (0 disables)")
	fs.IntVar(&createBurst, "create-burst", 5, "create_room burst size")
	fs.Float64Var(&joinPerMin, "join-per-min", 10, "join_room attempts per minute per IP (0 disables)")
	fs.IntVar(&joinBurst, "join-burst", 5, "join_room burst size")
	fs.BoolVar(&trustXFF, "trust-xff", false, "derive source IP from X-Forwarded-For (only when fronted by a trusted proxy)")
	fs.StringVar(&cfTurnKeyID, "cloudflare-turn-key-id", "", "Cloudflare Realtime TURN key ID (paired with --cloudflare-turn-api-token)")
	fs.StringVar(&cfTurnAPIToken, "cloudflare-turn-api-token", "", "Cloudflare Realtime TURN per-key API token (paired with --cloudflare-turn-key-id)")
	fs.IntVar(&cfTurnTTLSeconds, "cloudflare-turn-ttl-seconds", 3600, "TTL requested for each Cloudflare-issued TURN credential")
	if err := ff.Parse(fs, os.Args[1:], ff.WithEnvVarPrefix("WISP")); err != nil {
		return fmt.Errorf("parsing flags: %w", err)
	}

	cfTurnEnabled := cfTurnKeyID != "" || cfTurnAPIToken != ""
	if cfTurnEnabled {
		if cfTurnKeyID == "" || cfTurnAPIToken == "" {
			return fmt.Errorf("validating flags: --cloudflare-turn-key-id and --cloudflare-turn-api-token must be set together")
		}
		if cfTurnTTLSeconds <= 0 {
			return fmt.Errorf("validating flags: --cloudflare-turn-ttl-seconds must be positive, got %d", cfTurnTTLSeconds)
		}
	}

	opts := []signaling.Option{
		signaling.WithTrustXForwardedFor(trustXFF),
		signaling.WithMaxRooms(maxRooms),
		signaling.WithMaxPeersPerRoom(maxPeersPerRoom),
	}
	if createPerMin > 0 {
		opts = append(opts, signaling.WithCreateLimiter(&ratelimit.KeyedLimiter{
			Rate:    rate.Limit(createPerMin / 60),
			Burst:   createBurst,
			IdleTTL: 15 * time.Minute,
		}))
	}
	if joinPerMin > 0 {
		opts = append(opts, signaling.WithJoinLimiter(&ratelimit.KeyedLimiter{
			Rate:    rate.Limit(joinPerMin / 60),
			Burst:   joinBurst,
			IdleTTL: 15 * time.Minute,
		}))
	}
	if cfTurnEnabled {
		cfIss, err := turnauth.NewCloudflareIssuer(cfTurnKeyID, cfTurnAPIToken, time.Duration(cfTurnTTLSeconds)*time.Second)
		if err != nil {
			return fmt.Errorf("creating cloudflare turn issuer: %w", err)
		}
		opts = append(opts, signaling.WithTurnIssuer(cfIss))
		logger.InfoContext(ctx, "using Cloudflare Realtime TURN", slog.String("key_id", cfTurnKeyID), slog.Int("ttl_seconds", cfTurnTTLSeconds))
	}
	srv := signaling.NewServer(logger, opts...)

	webSub, err := iofs.Sub(webFS, "web")
	if err != nil {
		return fmt.Errorf("embedding web assets: %w", err)
	}
	// embed.FS files all carry a zero modtime, so http.FileServer emits no
	// Last-Modified or ETag and browsers fall back to heuristic caching that
	// can outlive a deploy. Precompute a SHA-256 ETag per asset and pair it
	// with Cache-Control: no-cache so the browser always revalidates.
	etags, err := assetETags(webSub)
	if err != nil {
		return fmt.Errorf("hashing web assets: %w", err)
	}
	encoded, hidden, err := loadEncodedAssets(webSub)
	if err != nil {
		return fmt.Errorf("loading precompressed web assets: %w", err)
	}
	fileSrv := http.FileServer(http.FS(webSub))
	static := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Precompressed sibling files (foo.css.br, foo.css.gz) are
		// implementation detail; clients shouldn't fetch them directly.
		if hidden[r.URL.Path] {
			http.NotFound(w, r)
			return
		}
		etag, hasEtag := etags[r.URL.Path]
		if hasEtag {
			w.Header().Set("Etag", etag)
			w.Header().Set("Cache-Control", "no-cache")
		}
		// Vary on Accept-Encoding even for fall-through assets so caches
		// don't cross-feed compressed and identity bodies.
		w.Header().Add("Vary", "Accept-Encoding")
		if asset, ok := encoded[r.URL.Path]; ok {
			body, enc := negotiateEncoding(r, asset)
			if body != nil {
				w.Header().Set("Content-Type", asset.contentType)
				w.Header().Set("Content-Encoding", enc)
				w.Header().Set("Content-Length", fmt.Sprintf("%d", len(body)))
				// Only honor If-None-Match for the encoded representation.
				if hasEtag && strings.Contains(r.Header.Get("If-None-Match"), etag) {
					w.WriteHeader(http.StatusNotModified)
					return
				}
				if r.Method == http.MethodHead {
					return
				}
				_, _ = w.Write(body)
				return
			}
		}
		if strings.HasSuffix(r.URL.Path, ".wasm") {
			w.Header().Set("Content-Type", "application/wasm")
		}
		fileSrv.ServeHTTP(w, r)
	})

	mux := http.NewServeMux()
	mux.HandleFunc("GET /ws", srv.HandleWS)
	mux.HandleFunc("GET /healthz", srv.HandleHealthz)
	mux.Handle("GET /", static)

	httpServer := http.Server{
		Addr:              addr,
		Handler:           mux,
		ReadHeaderTimeout: 10 * time.Second,
	}

	serveCtx, cancel := context.WithCancel(ctx)
	defer cancel()

	var eg errgroup.Group
	eg.Go(func() error {
		<-serveCtx.Done()
		shutdownCtx, cancelShutdown := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancelShutdown()
		return httpServer.Shutdown(shutdownCtx)
	})

	logger.InfoContext(ctx, "wisp listening", slog.String("addr", addr))
	serveErr := httpServer.ListenAndServe()
	cancel()
	shutdownErr := eg.Wait()

	if serveErr != nil && serveErr != http.ErrServerClosed {
		return fmt.Errorf("listening and serving: %w", serveErr)
	}
	if shutdownErr != nil {
		return fmt.Errorf("shutting down: %w", shutdownErr)
	}
	return nil
}

// encodedAsset is a precompressed embedded file together with the Content-Type
// of its decoded representation. The content type comes from the file's
// extension (after stripping the encoding suffix) because http.ResponseWriter's
// auto-sniff would inspect the encoded header instead of the underlying bytes
// once Content-Encoding is set. Either body may be nil if the build didn't
// produce that variant.
type encodedAsset struct {
	contentType string
	br          []byte
	gz          []byte
}

// loadEncodedAssets scans fsys for precompressed sibling files (foo.br,
// foo.gz) emitted by the client build. Returns the per-path encoded bodies
// plus the set of URL paths that should 404 because they're encoding
// implementation detail rather than user-visible assets.
func loadEncodedAssets(fsys iofs.FS) (map[string]encodedAsset, map[string]bool, error) {
	files := map[string]bool{}
	if err := iofs.WalkDir(fsys, ".", func(p string, d iofs.DirEntry, err error) error {
		if err != nil {
			return fmt.Errorf("walking %q: %w", p, err)
		}
		if !d.IsDir() {
			files[p] = true
		}
		return nil
	}); err != nil {
		return nil, nil, fmt.Errorf("walking embedded assets: %w", err)
	}

	out := map[string]encodedAsset{}
	hidden := map[string]bool{}
	for p := range files {
		// Process each base file once. .br/.gz are sibling encodings only
		// when their stripped sibling also exists; .tar.gz stands alone.
		if isEncodingSibling(p, files) {
			hidden["/"+p] = true
			continue
		}
		brPath := p + ".br"
		gzPath := p + ".gz"
		var br, gz []byte
		if files[brPath] {
			b, err := iofs.ReadFile(fsys, brPath)
			if err != nil {
				return nil, nil, fmt.Errorf("reading %q: %w", brPath, err)
			}
			br = b
		}
		if files[gzPath] {
			b, err := iofs.ReadFile(fsys, gzPath)
			if err != nil {
				return nil, nil, fmt.Errorf("reading %q: %w", gzPath, err)
			}
			gz = b
		}
		if br == nil && gz == nil {
			continue
		}
		ct := mime.TypeByExtension(path.Ext(p))
		if ct == "" && strings.HasSuffix(p, ".wasm") {
			ct = "application/wasm"
		}
		if ct == "" {
			// http.FileServer will sniff from the original bytes, but we
			// need a concrete type since Content-Encoding suppresses sniff.
			raw, err := iofs.ReadFile(fsys, p)
			if err != nil {
				return nil, nil, fmt.Errorf("reading %q: %w", p, err)
			}
			ct = http.DetectContentType(raw)
		}
		entry := encodedAsset{contentType: ct, br: br, gz: gz}
		out["/"+p] = entry
		if p == "index.html" {
			out["/"] = entry
		}
	}
	return out, hidden, nil
}

// isEncodingSibling reports whether p is a precompressed sibling (foo.br or
// foo.gz) of another file in the set. The .tar.gz model archive is its own
// payload, not a sibling, because there's no .tar without it.
func isEncodingSibling(p string, files map[string]bool) bool {
	for _, suffix := range []string{".br", ".gz"} {
		if strings.HasSuffix(p, suffix) && files[strings.TrimSuffix(p, suffix)] {
			return true
		}
	}
	return false
}

// negotiateEncoding picks the best encoded representation the client accepts.
// Brotli wins over gzip whenever both are acceptable. Returns (nil, "") if the
// client accepts neither or no precompressed body is available.
func negotiateEncoding(r *http.Request, asset encodedAsset) ([]byte, string) {
	br, gz := acceptsEncoding(r, "br"), acceptsEncoding(r, "gzip")
	if br && asset.br != nil {
		return asset.br, "br"
	}
	if gz && asset.gz != nil {
		return asset.gz, "gzip"
	}
	return nil, ""
}

// acceptsEncoding reports whether the client's Accept-Encoding header
// includes the named coding with non-zero quality.
func acceptsEncoding(r *http.Request, coding string) bool {
	for part := range strings.SplitSeq(r.Header.Get("Accept-Encoding"), ",") {
		token, params, _ := strings.Cut(strings.TrimSpace(part), ";")
		if !strings.EqualFold(token, coding) && token != "*" {
			continue
		}
		// Honor "q=0" per RFC 9110.
		for param := range strings.SplitSeq(params, ";") {
			k, v, ok := strings.Cut(strings.TrimSpace(param), "=")
			if ok && strings.EqualFold(k, "q") && strings.TrimSpace(v) == "0" {
				return false
			}
		}
		return true
	}
	return false
}

// assetETags returns a map from URL request path to a strong ETag for each
// embedded file. The map covers both "/path" and, for index.html, the bare
// "/" so http.FileServer's directory-index lookup hits a precomputed entry.
func assetETags(fsys iofs.FS) (map[string]string, error) {
	etags := map[string]string{}
	err := iofs.WalkDir(fsys, ".", func(p string, d iofs.DirEntry, err error) error {
		if err != nil {
			return fmt.Errorf("walking %q: %w", p, err)
		}
		if d.IsDir() {
			return nil
		}
		data, err := iofs.ReadFile(fsys, p)
		if err != nil {
			return fmt.Errorf("reading %q: %w", p, err)
		}
		sum := sha256.Sum256(data)
		etag := `"` + hex.EncodeToString(sum[:]) + `"`
		etags["/"+p] = etag
		if p == "index.html" {
			etags["/"] = etag
		}
		return nil
	})
	if err != nil {
		return nil, fmt.Errorf("walking embedded assets: %w", err)
	}
	return etags, nil
}
