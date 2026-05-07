// Package signaling implements the wisp signaling server.
//
// The server brokers room membership and relays WebRTC SDP/ICE between peers
// in the same room. It does not see media (SRTP between peers) and does not
// see plaintext group keys (peers wrap them to each other's ephemeral X25519
// public keys before handing them to the server for delivery).
//
// Wire envelopes are defined in package wire.
package signaling

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
	"github.com/danielmmetz/wisp/internal/ratelimit"
	"github.com/danielmmetz/wisp/internal/turnauth"
	"github.com/danielmmetz/wisp/internal/wire"
)

const (
	defaultMaxPeersPerRoom = 6
	defaultMaxRooms        = 1000
	defaultHelloTimeout    = 10 * time.Second
	defaultPingInterval    = 25 * time.Second
	defaultCodeCooldown    = 5 * time.Minute
	defaultMsgRate         = 50 // per connection per second
	defaultMsgBurst        = 100
	codeAllocAttempts      = 64
)

// Server is the signaling HTTP handler. Construct via NewServer.
type Server struct {
	logger             *slog.Logger
	maxPeersPerRoom    int
	maxRooms           int
	helloTimeout       time.Duration
	pingInterval       time.Duration
	codeCooldown       time.Duration
	msgRate            float64
	msgBurst           int
	joinLimiter        *ratelimit.KeyedLimiter
	createLimiter      *ratelimit.KeyedLimiter
	turnIssuer         turnauth.Issuer
	trustXForwardedFor bool
	now                func() time.Time

	mu        sync.Mutex
	rooms     map[string]*room
	cooldowns map[string]time.Time
}

// Option configures a Server in NewServer.
type Option func(*Server)

func WithMaxPeersPerRoom(n int) Option { return func(s *Server) { s.maxPeersPerRoom = n } }
func WithMaxRooms(n int) Option        { return func(s *Server) { s.maxRooms = n } }
func WithHelloTimeout(d time.Duration) Option {
	return func(s *Server) { s.helloTimeout = d }
}
func WithPingInterval(d time.Duration) Option { return func(s *Server) { s.pingInterval = d } }
func WithCodeCooldown(d time.Duration) Option { return func(s *Server) { s.codeCooldown = d } }
func WithMessageRate(rate float64, burst int) Option {
	return func(s *Server) { s.msgRate = rate; s.msgBurst = burst }
}
func WithJoinLimiter(l *ratelimit.KeyedLimiter) Option {
	return func(s *Server) { s.joinLimiter = l }
}
func WithCreateLimiter(l *ratelimit.KeyedLimiter) Option {
	return func(s *Server) { s.createLimiter = l }
}
func WithTurnIssuer(iss turnauth.Issuer) Option { return func(s *Server) { s.turnIssuer = iss } }
func WithTrustXForwardedFor(trust bool) Option {
	return func(s *Server) { s.trustXForwardedFor = trust }
}

// NewServer builds a signaling server with the given logger and options.
func NewServer(logger *slog.Logger, opts ...Option) *Server {
	s := &Server{
		logger:          logger,
		maxPeersPerRoom: defaultMaxPeersPerRoom,
		maxRooms:        defaultMaxRooms,
		helloTimeout:    defaultHelloTimeout,
		pingInterval:    defaultPingInterval,
		codeCooldown:    defaultCodeCooldown,
		msgRate:         defaultMsgRate,
		msgBurst:        defaultMsgBurst,
		now:             time.Now,
		rooms:           make(map[string]*room),
		cooldowns:       make(map[string]time.Time),
	}
	for _, opt := range opts {
		opt(s)
	}
	return s
}

// room is the per-code shared state. peers may be read or written under
// Server.mu (room map operations) or via the room's own peers map under the
// server lock; we keep all room mutations under Server.mu for simplicity —
// peers per room is small and contention is negligible.
type room struct {
	code  wire.Code
	peers map[string]*peerConn
}

// peerConn binds a WebSocket connection to its room membership. The conn
// is owned by the read goroutine; other goroutines may only call Write
// (coder/websocket serializes Write internally) and CloseNow.
//
// name is mutated only under Server.mu; readers (broadcast snapshot, peer
// list for joiners) also hold the lock so they observe a consistent value.
//
// kicked marks a peer whose conn is being torn down because another peer
// called kick. It's set under Server.mu before closing the conn so the
// removePeer broadcast suppresses peer_left for them — peer_kicked has
// already gone out as the canonical removal event.
type peerConn struct {
	id           string
	publicKey    string
	supportsE2EE bool
	name         string
	conn         *websocket.Conn
	kicked       bool
}

// HandleHealthz reports liveness for Fly's health checks.
func (s *Server) HandleHealthz(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	_, _ = w.Write([]byte("ok\n"))
}

// HandleWS accepts a WebSocket connection and dispatches on the client's
// first frame.
func (s *Server) HandleWS(w http.ResponseWriter, r *http.Request) {
	ip := s.sourceIP(r)
	logger := s.logger.With(slog.String("remote", ip))

	conn, err := websocket.Accept(w, r, nil)
	if err != nil {
		logger.WarnContext(r.Context(), "ws accept failed", slog.Any("err", err))
		return
	}
	defer conn.CloseNow()

	helloCtx, cancel := context.WithTimeout(r.Context(), s.helloTimeout)
	_, data, err := conn.Read(helloCtx)
	cancel()
	if err != nil {
		logger.DebugContext(r.Context(), "hello read failed", slog.Any("err", err))
		return
	}

	var env wire.Envelope
	if err := json.Unmarshal(data, &env); err != nil {
		writeError(r.Context(), conn, wire.ErrBadRequest, "invalid json")
		return
	}

	switch env.Type {
	case wire.TypeCreateRoom:
		if s.createLimiter != nil && !s.createLimiter.Allow(ip) {
			writeError(r.Context(), conn, wire.ErrRateLimited, "create rate limit")
			return
		}
		var p wire.CreateRoomPayload
		if err := json.Unmarshal(env.Payload, &p); err != nil || p.PublicKey == "" {
			writeError(r.Context(), conn, wire.ErrBadRequest, "invalid create_room payload")
			return
		}
		s.handleCreate(r.Context(), logger, conn, p.PublicKey, p.SupportsE2EE, wire.NormalizeName(p.Name))
	case wire.TypeJoinRoom:
		if s.joinLimiter != nil && !s.joinLimiter.Allow(ip) {
			writeError(r.Context(), conn, wire.ErrRateLimited, "join rate limit")
			return
		}
		var p wire.JoinRoomPayload
		if err := json.Unmarshal(env.Payload, &p); err != nil || p.PublicKey == "" || p.Code == "" {
			writeError(r.Context(), conn, wire.ErrBadRequest, "invalid join_room payload")
			return
		}
		s.handleJoin(r.Context(), logger, conn, p.Code, p.PublicKey, p.SupportsE2EE, wire.NormalizeName(p.Name))
	default:
		writeError(r.Context(), conn, wire.ErrBadRequest, "first frame must be create_room or join_room")
	}
}

func (s *Server) handleCreate(ctx context.Context, logger *slog.Logger, conn *websocket.Conn, publicKey string, supportsE2EE bool, name string) {
	pc := &peerConn{id: newPeerID(), publicKey: publicKey, supportsE2EE: supportsE2EE, name: name, conn: conn}
	rm, code, err := s.allocateRoom(pc)
	if err != nil {
		switch {
		case errors.Is(err, errRoomCapacity):
			writeError(ctx, conn, wire.ErrCapacity, "server at capacity")
		case errors.Is(err, errCodeExhausted):
			writeError(ctx, conn, wire.ErrRoomGenFailed, "could not allocate a fresh code")
		default:
			writeError(ctx, conn, wire.ErrInternal, err.Error())
		}
		return
	}
	logger = logger.With(slog.String("room", code.String()), slog.String("peer", pc.id))
	logger.InfoContext(ctx, "room created")

	if err := writeJSON(ctx, conn, envelope(wire.TypeRoomCreated, wire.RoomCreatedPayload{
		Code:   code.String(),
		PeerID: pc.id,
		Name:   pc.name,
		TURN:   s.issueTURN(ctx, logger),
	})); err != nil {
		s.removePeer(rm, pc, logger)
		return
	}
	s.runPeer(ctx, logger, rm, pc)
}

func (s *Server) handleJoin(ctx context.Context, logger *slog.Logger, conn *websocket.Conn, codeStr, publicKey string, supportsE2EE bool, name string) {
	code, err := wire.ParseCode(codeStr)
	if err != nil {
		writeError(ctx, conn, wire.ErrBadRequest, err.Error())
		return
	}
	pc := &peerConn{id: newPeerID(), publicKey: publicKey, supportsE2EE: supportsE2EE, name: name, conn: conn}

	rm, existing, status := s.attachPeer(code, pc)
	switch status {
	case attachFull:
		writeError(ctx, conn, wire.ErrRoomFull, "room is full")
		return
	case attachCapacity:
		writeError(ctx, conn, wire.ErrCapacity, "server at capacity")
		return
	}

	logger = logger.With(slog.String("room", code.String()), slog.String("peer", pc.id))

	if status == attachCreated {
		logger.InfoContext(ctx, "room created via join")
		if err := writeJSON(ctx, conn, envelope(wire.TypeRoomCreated, wire.RoomCreatedPayload{
			Code:   code.String(),
			PeerID: pc.id,
			Name:   pc.name,
			TURN:   s.issueTURN(ctx, logger),
		})); err != nil {
			s.removePeer(rm, pc, logger)
			return
		}
		s.runPeer(ctx, logger, rm, pc)
		return
	}

	logger.InfoContext(ctx, "peer joined", slog.Int("peer_count", len(existing)+1))

	if err := writeJSON(ctx, conn, envelope(wire.TypeRoomJoined, wire.RoomJoinedPayload{
		Code:   code.String(),
		PeerID: pc.id,
		Name:   pc.name,
		Peers:  existing,
		TURN:   s.issueTURN(ctx, logger),
	})); err != nil {
		s.removePeer(rm, pc, logger)
		return
	}
	// Tell every existing peer the new one arrived. We hold no locks here:
	// peers can leave concurrently, and a stale write to a dead conn is
	// harmless.
	s.broadcast(ctx, rm, pc.id, envelope(wire.TypePeerJoined, wire.PeerJoinedPayload{
		PeerID:       pc.id,
		PublicKey:    pc.publicKey,
		SupportsE2EE: pc.supportsE2EE,
		Name:         pc.name,
	}))

	s.runPeer(ctx, logger, rm, pc)
}

// runPeer reads from pc's connection until ctx is cancelled or the peer
// errors out. Each frame is dispatched to the in-room handler. On exit,
// the peer is removed from the room and peer_left is broadcast.
func (s *Server) runPeer(ctx context.Context, logger *slog.Logger, rm *room, pc *peerConn) {
	// Defer order matters: heartbeat goroutine must exit before removePeer
	// runs so we don't write to a half-cleaned conn. cancel() comes before
	// wg.Wait() in LIFO order, so the heartbeat sees ctx.Done and exits.
	defer s.removePeer(rm, pc, logger)
	var wg sync.WaitGroup
	defer wg.Wait()
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()

	wg.Go(func() { s.runHeartbeat(ctx, pc.conn, cancel) })

	// No per-read deadline: voice sessions go fully signaling-idle once
	// SDP/ICE is exchanged (audio flows direct via SRTP). Liveness comes
	// from the heartbeat ping; if the peer's network silently drops, the
	// ping fails and ctx is cancelled, which unblocks Read.
	limiter := newConnLimiter(s.msgRate, s.msgBurst, s.now)
	for {
		typ, data, err := pc.conn.Read(ctx)
		if err != nil {
			if !isCleanClose(err) && ctx.Err() == nil {
				logger.InfoContext(ctx, "peer read ended", slog.Any("err", err))
			}
			return
		}
		if typ != websocket.MessageText {
			writeError(ctx, pc.conn, wire.ErrBadRequest, "binary frames not accepted")
			return
		}
		if !limiter.Allow() {
			writeError(ctx, pc.conn, wire.ErrRateLimited, "message rate limit")
			return
		}

		var env wire.Envelope
		if err := json.Unmarshal(data, &env); err != nil {
			writeError(ctx, pc.conn, wire.ErrBadRequest, "invalid json")
			continue
		}
		switch env.Type {
		case wire.TypeSignal:
			s.handleSignal(ctx, logger, rm, pc, env.Payload)
		case wire.TypeRename:
			s.handleRename(ctx, logger, rm, pc, env.Payload)
		case wire.TypeKick:
			s.handleKick(ctx, logger, rm, pc, env.Payload)
		case wire.TypeLeaveRoom:
			logger.DebugContext(ctx, "peer leave_room")
			return
		default:
			// Tolerate unknown types — protocol may add new client→server
			// frames in the future and old servers should not break new
			// clients.
			logger.DebugContext(ctx, "ignoring unknown type", slog.String("type", env.Type))
		}
	}
}

func (s *Server) handleRename(ctx context.Context, logger *slog.Logger, rm *room, from *peerConn, raw json.RawMessage) {
	var p wire.RenamePayload
	if err := json.Unmarshal(raw, &p); err != nil {
		writeError(ctx, from.conn, wire.ErrBadRequest, "invalid rename payload")
		return
	}
	name := wire.NormalizeName(p.Name)

	// Update under the lock and snapshot recipients in one pass; broadcast
	// outside the lock. Self is included so its view advances only after
	// the server has accepted the rename, keeping all clients in sync.
	s.mu.Lock()
	if _, present := rm.peers[from.id]; !present {
		s.mu.Unlock()
		return
	}
	from.name = name
	targets := make([]*peerConn, 0, len(rm.peers))
	for _, p := range rm.peers {
		targets = append(targets, p)
	}
	s.mu.Unlock()

	logger.DebugContext(ctx, "peer renamed", slog.String("name", name))
	out := envelope(wire.TypePeerRenamed, wire.PeerRenamedPayload{PeerID: from.id, Name: name})
	for _, p := range targets {
		_ = writeJSON(ctx, p.conn, out)
	}
}

// handleKick removes the named peer from rm. Any peer in the room may kick
// any other peer; the room is the trust boundary, so we don't gate on roles.
// The target's conn is closed so its read loop tears down naturally; before
// closing we mark the peer kicked and broadcast peer_kicked to every member
// (including the target). removePeer skips its peer_left broadcast for
// kicked peers so clients see a single removal event with kicker context.
func (s *Server) handleKick(ctx context.Context, logger *slog.Logger, rm *room, from *peerConn, raw json.RawMessage) {
	var p wire.KickPayload
	if err := json.Unmarshal(raw, &p); err != nil {
		writeError(ctx, from.conn, wire.ErrBadRequest, "invalid kick payload")
		return
	}
	if p.PeerID == "" || p.PeerID == from.id {
		writeError(ctx, from.conn, wire.ErrBadRequest, "kick.peerId invalid")
		return
	}

	// Snapshot recipients and mark target kicked under the lock so a
	// concurrent leave/kick can't race the conn close.
	s.mu.Lock()
	target, ok := rm.peers[p.PeerID]
	if !ok {
		s.mu.Unlock()
		writeError(ctx, from.conn, wire.ErrPeerNotFound, "target peer not in room")
		return
	}
	if target.kicked {
		// Another kicker already raced ahead; don't double-broadcast.
		s.mu.Unlock()
		return
	}
	target.kicked = true
	targets := make([]*peerConn, 0, len(rm.peers))
	for _, pp := range rm.peers {
		targets = append(targets, pp)
	}
	s.mu.Unlock()

	logger.InfoContext(ctx, "peer kicked",
		slog.String("target", target.id), slog.String("by", from.id))
	out := envelope(wire.TypePeerKicked, wire.PeerKickedPayload{PeerID: target.id, By: from.id})
	for _, pp := range targets {
		_ = writeJSON(ctx, pp.conn, out)
	}
	// Closing the conn unblocks the target's Read in runPeer, which then
	// flows through removePeer for cleanup. removePeer notices kicked=true
	// and skips its peer_left broadcast.
	_ = target.conn.Close(websocket.StatusPolicyViolation, "kicked")
}

func (s *Server) handleSignal(ctx context.Context, logger *slog.Logger, rm *room, from *peerConn, raw json.RawMessage) {
	var p wire.SignalPayload
	if err := json.Unmarshal(raw, &p); err != nil {
		writeError(ctx, from.conn, wire.ErrBadRequest, "invalid signal payload")
		return
	}
	if p.To == "" || p.To == from.id {
		writeError(ctx, from.conn, wire.ErrBadRequest, "signal.to invalid")
		return
	}
	target := s.peerInRoom(rm, p.To)
	if target == nil {
		writeError(ctx, from.conn, wire.ErrPeerNotFound, "destination peer not in room")
		return
	}
	out := envelope(wire.TypeSignal, wire.SignalForwardedPayload{From: from.id, Data: p.Data})
	if err := writeJSON(ctx, target.conn, out); err != nil {
		// Target is gone. Its read loop will tear it down; we just drop
		// this frame.
		logger.DebugContext(ctx, "signal forward write failed", slog.String("to", p.To), slog.Any("err", err))
	}
}

// allocateRoom picks an unused, non-cooldown code and registers the creator.
// Returns the room, the chosen code, or an error.
var (
	errRoomCapacity  = errors.New("server at room capacity")
	errCodeExhausted = errors.New("could not allocate a fresh code")
)

func (s *Server) allocateRoom(creator *peerConn) (*room, wire.Code, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	s.gcCooldownsLocked()
	if s.maxRooms > 0 && len(s.rooms) >= s.maxRooms {
		return nil, wire.Code{}, errRoomCapacity
	}
	for range codeAllocAttempts {
		code, err := wire.FormatCode()
		if err != nil {
			return nil, wire.Code{}, fmt.Errorf("generating code: %w", err)
		}
		key := code.String()
		if _, exists := s.rooms[key]; exists {
			continue
		}
		if _, cooling := s.cooldowns[key]; cooling {
			continue
		}
		rm := &room{code: code, peers: map[string]*peerConn{creator.id: creator}}
		s.rooms[key] = rm
		return rm, code, nil
	}
	return nil, wire.Code{}, errCodeExhausted
}

type attachStatus int

const (
	attachJoined attachStatus = iota
	attachCreated
	attachFull
	attachCapacity
)

// attachPeer joins pc to the room with the given code, creating the room
// if it doesn't yet exist. The same atomic step under s.mu handles both
// outcomes so concurrent joiners of a missing code converge cleanly:
// whichever lock holder runs first creates, the rest join. On a join, the
// returned slice snapshots the existing peers (for room_joined). On a
// create, it is empty.
//
// Cooldowns are intentionally not checked here. Their job is to prevent
// random allocation in allocateRoom from re-handing-out a freshly-freed
// code; an explicit join means the user already has the code, so an
// errant refresh or navigation can rebuild the room from the same link.
func (s *Server) attachPeer(code wire.Code, pc *peerConn) (*room, []wire.PeerInfo, attachStatus) {
	s.mu.Lock()
	defer s.mu.Unlock()

	key := code.String()
	if rm, ok := s.rooms[key]; ok {
		if len(rm.peers) >= s.maxPeersPerRoom {
			return nil, nil, attachFull
		}
		existing := make([]wire.PeerInfo, 0, len(rm.peers))
		for _, p := range rm.peers {
			existing = append(existing, wire.PeerInfo{
				ID:           p.id,
				PublicKey:    p.publicKey,
				SupportsE2EE: p.supportsE2EE,
				Name:         p.name,
			})
		}
		rm.peers[pc.id] = pc
		return rm, existing, attachJoined
	}
	if s.maxRooms > 0 && len(s.rooms) >= s.maxRooms {
		return nil, nil, attachCapacity
	}
	rm := &room{code: code, peers: map[string]*peerConn{pc.id: pc}}
	s.rooms[key] = rm
	return rm, nil, attachCreated
}

// peerInRoom returns the peer with id in rm or nil.
func (s *Server) peerInRoom(rm *room, id string) *peerConn {
	s.mu.Lock()
	defer s.mu.Unlock()
	return rm.peers[id]
}

// removePeer drops pc from rm and broadcasts peer_left to remaining peers.
// Idempotent; safe to defer. For kicked peers, peer_left is suppressed —
// handleKick already broadcast peer_kicked as the canonical removal event.
func (s *Server) removePeer(rm *room, pc *peerConn, logger *slog.Logger) {
	s.mu.Lock()
	if _, present := rm.peers[pc.id]; !present {
		s.mu.Unlock()
		return
	}
	delete(rm.peers, pc.id)
	remaining := make([]*peerConn, 0, len(rm.peers))
	for _, p := range rm.peers {
		remaining = append(remaining, p)
	}
	roomEmpty := len(rm.peers) == 0
	if roomEmpty {
		delete(s.rooms, rm.code.String())
		s.cooldowns[rm.code.String()] = s.now().Add(s.codeCooldown)
	}
	wasKicked := pc.kicked
	s.mu.Unlock()

	logger.InfoContext(context.Background(), "peer removed",
		slog.Int("remaining", len(remaining)),
		slog.Bool("room_closed", roomEmpty),
		slog.Bool("kicked", wasKicked))

	if !roomEmpty && !wasKicked {
		out := envelope(wire.TypePeerLeft, wire.PeerLeftPayload{PeerID: pc.id})
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		for _, p := range remaining {
			_ = writeJSON(ctx, p.conn, out)
		}
	}
}

// gcCooldownsLocked discards expired cooldowns. Caller holds s.mu.
func (s *Server) gcCooldownsLocked() {
	now := s.now()
	for k, exp := range s.cooldowns {
		if !exp.After(now) {
			delete(s.cooldowns, k)
		}
	}
}

// broadcast sends env to every peer in rm except excludeID. Failures are
// dropped — the affected peer's read loop handles teardown.
func (s *Server) broadcast(ctx context.Context, rm *room, excludeID string, env wire.Envelope) {
	s.mu.Lock()
	targets := make([]*peerConn, 0, len(rm.peers))
	for _, p := range rm.peers {
		if p.id == excludeID {
			continue
		}
		targets = append(targets, p)
	}
	s.mu.Unlock()

	for _, p := range targets {
		_ = writeJSON(ctx, p.conn, env)
	}
}

// runHeartbeat sends WebSocket pings on conn until ctx is cancelled. A
// failed ping cancels the connection so Read unblocks and the peer is
// cleaned up. Read itself has no per-call deadline because voice sessions
// go fully signaling-idle once SDP/ICE finishes (audio flows direct via
// SRTP); the heartbeat is the sole liveness check.
func (s *Server) runHeartbeat(ctx context.Context, conn *websocket.Conn, cancel context.CancelFunc) {
	if s.pingInterval <= 0 {
		return
	}
	t := time.NewTicker(s.pingInterval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			ctx, pcancel := context.WithTimeout(ctx, s.pingInterval)
			err := conn.Ping(ctx)
			pcancel()
			if err != nil {
				cancel()
				return
			}
		}
	}
}

// issueTURN mints credentials for a single peer. Returns nil on absent
// issuer or transient error; callers treat absence as "no TURN this round"
// so a Cloudflare blip doesn't break room joining for users with direct
// connectivity.
func (s *Server) issueTURN(ctx context.Context, logger *slog.Logger) *wire.TurnCreds {
	if s.turnIssuer == nil {
		return nil
	}
	creds, err := s.turnIssuer.Issue(ctx)
	if err != nil {
		logger.WarnContext(ctx, "issuing turn credentials", slog.Any("err", err))
		return nil
	}
	return &wire.TurnCreds{
		URIs:       creds.URIs,
		Username:   creds.Username,
		Credential: creds.Credential,
		TTL:        creds.TTL,
	}
}

// ActiveRooms returns the count of live rooms (tests and metrics).
func (s *Server) ActiveRooms() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.rooms)
}

// ActivePeers returns the total live peer count across rooms.
func (s *Server) ActivePeers() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	n := 0
	for _, rm := range s.rooms {
		n += len(rm.peers)
	}
	return n
}

func (s *Server) sourceIP(r *http.Request) string {
	if s.trustXForwardedFor {
		if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
			parts := strings.Split(xff, ",")
			last := strings.TrimSpace(parts[len(parts)-1])
			if last != "" {
				return last
			}
		}
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

func envelope(t string, p any) wire.Envelope {
	raw, _ := json.Marshal(p)
	return wire.Envelope{Type: t, Payload: raw}
}

func writeJSON(ctx context.Context, conn *websocket.Conn, v any) error {
	data, err := json.Marshal(v)
	if err != nil {
		return fmt.Errorf("marshaling control frame: %w", err)
	}
	if err := conn.Write(ctx, websocket.MessageText, data); err != nil {
		return fmt.Errorf("writing control frame: %w", err)
	}
	return nil
}

func writeError(ctx context.Context, conn *websocket.Conn, code, message string) {
	_ = writeJSON(ctx, conn, envelope(wire.TypeError, wire.ErrorPayload{Code: code, Message: message}))
}

func isCleanClose(err error) bool {
	if err == nil {
		return true
	}
	switch websocket.CloseStatus(err) {
	case websocket.StatusNormalClosure, websocket.StatusGoingAway, websocket.StatusNoStatusRcvd:
		return true
	}
	return errors.Is(err, io.EOF) || errors.Is(err, context.Canceled) ||
		errors.Is(err, context.DeadlineExceeded)
}

// newPeerID returns a 16-hex-char random ID. 64 bits is enough to make
// collisions astronomically unlikely within a max-1000-room server.
func newPeerID() string {
	var b [8]byte
	_, _ = rand.Read(b[:])
	return hex.EncodeToString(b[:])
}
