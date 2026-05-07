package signaling_test

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/danielmmetz/wisp/internal/signaling"
	"github.com/danielmmetz/wisp/internal/wire"
)

type testHarness struct {
	ts     *httptest.Server
	server *signaling.Server
}

func newHarness(t *testing.T, opts ...signaling.Option) *testHarness {
	t.Helper()
	logger := slog.New(slog.NewTextHandler(t.Output(), nil))
	defaults := []signaling.Option{
		signaling.WithHelloTimeout(2 * time.Second),
		signaling.WithPingInterval(0), // disable in tests
		signaling.WithCodeCooldown(0),
	}
	srv := signaling.NewServer(logger, append(defaults, opts...)...)
	mux := http.NewServeMux()
	mux.HandleFunc("GET /ws", srv.HandleWS)
	mux.HandleFunc("GET /healthz", srv.HandleHealthz)
	ts := httptest.NewServer(mux)
	t.Cleanup(ts.Close)
	return &testHarness{ts: ts, server: srv}
}

func (h *testHarness) dial(ctx context.Context, t *testing.T) *websocket.Conn {
	t.Helper()
	url := "ws" + strings.TrimPrefix(h.ts.URL, "http") + "/ws"
	conn, _, err := websocket.Dial(ctx, url, nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	t.Cleanup(func() { conn.CloseNow() })
	return conn
}

func writeJSON(t *testing.T, ctx context.Context, conn *websocket.Conn, v any) {
	t.Helper()
	data, err := json.Marshal(v)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if err := conn.Write(ctx, websocket.MessageText, data); err != nil {
		t.Fatalf("write: %v", err)
	}
}

func readEnvelope(t *testing.T, ctx context.Context, conn *websocket.Conn) wire.Envelope {
	t.Helper()
	_, data, err := conn.Read(ctx)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	var env wire.Envelope
	if err := json.Unmarshal(data, &env); err != nil {
		t.Fatalf("unmarshal %q: %v", data, err)
	}
	return env
}

func sendCreate(t *testing.T, ctx context.Context, conn *websocket.Conn, pk string) {
	t.Helper()
	raw, _ := json.Marshal(wire.CreateRoomPayload{PublicKey: pk})
	writeJSON(t, ctx, conn, wire.Envelope{Type: wire.TypeCreateRoom, Payload: raw})
}

func sendJoin(t *testing.T, ctx context.Context, conn *websocket.Conn, code, pk string) {
	t.Helper()
	raw, _ := json.Marshal(wire.JoinRoomPayload{Code: code, PublicKey: pk})
	writeJSON(t, ctx, conn, wire.Envelope{Type: wire.TypeJoinRoom, Payload: raw})
}

func mustPayload[T any](t *testing.T, env wire.Envelope) T {
	t.Helper()
	var p T
	if err := json.Unmarshal(env.Payload, &p); err != nil {
		t.Fatalf("decode %T from %q: %v", p, env.Payload, err)
	}
	return p
}

func TestHealthz(t *testing.T) {
	h := newHarness(t)
	resp, err := http.Get(h.ts.URL + "/healthz")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("status: %d", resp.StatusCode)
	}
}

func TestCreateRoom(t *testing.T) {
	h := newHarness(t)
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()

	conn := h.dial(ctx, t)
	sendCreate(t, ctx, conn, "PK_A")

	env := readEnvelope(t, ctx, conn)
	if env.Type != wire.TypeRoomCreated {
		t.Fatalf("type = %q want %q", env.Type, wire.TypeRoomCreated)
	}
	got := mustPayload[wire.RoomCreatedPayload](t, env)
	if _, err := wire.ParseCode(got.Code); err != nil {
		t.Fatalf("server returned invalid code %q: %v", got.Code, err)
	}
	if got.PeerID == "" {
		t.Fatalf("server returned empty peerId")
	}
	if h.server.ActiveRooms() != 1 {
		t.Fatalf("ActiveRooms = %d, want 1", h.server.ActiveRooms())
	}
	if h.server.ActivePeers() != 1 {
		t.Fatalf("ActivePeers = %d, want 1", h.server.ActivePeers())
	}
}

func TestJoinCreatesMissingRoom(t *testing.T) {
	h := newHarness(t)
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()

	conn := h.dial(ctx, t)
	sendJoin(t, ctx, conn, "velvet-otter", "PK_B")
	env := readEnvelope(t, ctx, conn)
	if env.Type != wire.TypeRoomCreated {
		t.Fatalf("type = %q want %q", env.Type, wire.TypeRoomCreated)
	}
	got := mustPayload[wire.RoomCreatedPayload](t, env)
	if got.Code != "velvet-otter" {
		t.Fatalf("code = %q want velvet-otter", got.Code)
	}
	if h.server.ActiveRooms() != 1 {
		t.Fatalf("ActiveRooms = %d, want 1", h.server.ActiveRooms())
	}
}

func TestJoinAndPeerJoinedNotification(t *testing.T) {
	h := newHarness(t)
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()

	a := h.dial(ctx, t)
	sendCreate(t, ctx, a, "PK_A")
	created := mustPayload[wire.RoomCreatedPayload](t, readEnvelope(t, ctx, a))

	b := h.dial(ctx, t)
	sendJoin(t, ctx, b, created.Code, "PK_B")
	joined := mustPayload[wire.RoomJoinedPayload](t, readEnvelope(t, ctx, b))
	if joined.Code != created.Code {
		t.Fatalf("joined code %q != created %q", joined.Code, created.Code)
	}
	if len(joined.Peers) != 1 {
		t.Fatalf("Peers len = %d, want 1", len(joined.Peers))
	}
	if joined.Peers[0].ID != created.PeerID || joined.Peers[0].PublicKey != "PK_A" {
		t.Fatalf("peer info = %+v want id=%q pk=PK_A", joined.Peers[0], created.PeerID)
	}

	// A should observe peer_joined for B.
	env := readEnvelope(t, ctx, a)
	if env.Type != wire.TypePeerJoined {
		t.Fatalf("type = %q want peer_joined", env.Type)
	}
	pj := mustPayload[wire.PeerJoinedPayload](t, env)
	if pj.PeerID != joined.PeerID || pj.PublicKey != "PK_B" {
		t.Fatalf("peer_joined = %+v", pj)
	}
}

func TestSignalRelay(t *testing.T) {
	h := newHarness(t)
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()

	a := h.dial(ctx, t)
	sendCreate(t, ctx, a, "PK_A")
	created := mustPayload[wire.RoomCreatedPayload](t, readEnvelope(t, ctx, a))

	b := h.dial(ctx, t)
	sendJoin(t, ctx, b, created.Code, "PK_B")
	joined := mustPayload[wire.RoomJoinedPayload](t, readEnvelope(t, ctx, b))
	_ = readEnvelope(t, ctx, a) // a's peer_joined for B

	// Send an opaque signal frame from A to B.
	rawData := json.RawMessage(`{"sdp":"hello"}`)
	sigPayload, _ := json.Marshal(wire.SignalPayload{To: joined.PeerID, Data: rawData})
	writeJSON(t, ctx, a, wire.Envelope{Type: wire.TypeSignal, Payload: sigPayload})

	env := readEnvelope(t, ctx, b)
	if env.Type != wire.TypeSignal {
		t.Fatalf("type = %q want signal", env.Type)
	}
	got := mustPayload[wire.SignalForwardedPayload](t, env)
	if got.From != created.PeerID {
		t.Fatalf("from = %q want %q", got.From, created.PeerID)
	}
	if string(got.Data) != string(rawData) {
		t.Fatalf("data = %s, want %s", got.Data, rawData)
	}
}

func TestSignalToUnknownPeer(t *testing.T) {
	h := newHarness(t)
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()

	a := h.dial(ctx, t)
	sendCreate(t, ctx, a, "PK_A")
	_ = readEnvelope(t, ctx, a)

	sig, _ := json.Marshal(wire.SignalPayload{To: "nope", Data: json.RawMessage(`{}`)})
	writeJSON(t, ctx, a, wire.Envelope{Type: wire.TypeSignal, Payload: sig})

	env := readEnvelope(t, ctx, a)
	if env.Type != wire.TypeError {
		t.Fatalf("type = %q want error", env.Type)
	}
	if got := mustPayload[wire.ErrorPayload](t, env); got.Code != wire.ErrPeerNotFound {
		t.Fatalf("code = %q want %q", got.Code, wire.ErrPeerNotFound)
	}
}

func TestPeerLeftBroadcastOnDisconnect(t *testing.T) {
	h := newHarness(t)
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()

	a := h.dial(ctx, t)
	sendCreate(t, ctx, a, "PK_A")
	created := mustPayload[wire.RoomCreatedPayload](t, readEnvelope(t, ctx, a))

	b := h.dial(ctx, t)
	sendJoin(t, ctx, b, created.Code, "PK_B")
	joined := mustPayload[wire.RoomJoinedPayload](t, readEnvelope(t, ctx, b))
	_ = readEnvelope(t, ctx, a) // peer_joined

	if err := b.Close(websocket.StatusNormalClosure, ""); err != nil {
		t.Fatalf("close b: %v", err)
	}

	env := readEnvelope(t, ctx, a)
	if env.Type != wire.TypePeerLeft {
		t.Fatalf("type = %q want peer_left", env.Type)
	}
	if got := mustPayload[wire.PeerLeftPayload](t, env); got.PeerID != joined.PeerID {
		t.Fatalf("peerId = %q want %q", got.PeerID, joined.PeerID)
	}
}

func TestRoomFull(t *testing.T) {
	h := newHarness(t, signaling.WithMaxPeersPerRoom(2))
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()

	a := h.dial(ctx, t)
	sendCreate(t, ctx, a, "PK_A")
	created := mustPayload[wire.RoomCreatedPayload](t, readEnvelope(t, ctx, a))

	b := h.dial(ctx, t)
	sendJoin(t, ctx, b, created.Code, "PK_B")
	_ = readEnvelope(t, ctx, b)
	_ = readEnvelope(t, ctx, a) // a's peer_joined

	c := h.dial(ctx, t)
	sendJoin(t, ctx, c, created.Code, "PK_C")
	env := readEnvelope(t, ctx, c)
	if env.Type != wire.TypeError {
		t.Fatalf("type = %q want error", env.Type)
	}
	if got := mustPayload[wire.ErrorPayload](t, env); got.Code != wire.ErrRoomFull {
		t.Fatalf("code = %q want %q", got.Code, wire.ErrRoomFull)
	}
}

func TestNamesPropagateAndRename(t *testing.T) {
	h := newHarness(t)
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()

	a := h.dial(ctx, t)
	rawCreate, _ := json.Marshal(wire.CreateRoomPayload{PublicKey: "PK_A", Name: "Alice"})
	writeJSON(t, ctx, a, wire.Envelope{Type: wire.TypeCreateRoom, Payload: rawCreate})
	created := mustPayload[wire.RoomCreatedPayload](t, readEnvelope(t, ctx, a))
	if created.Name != "Alice" {
		t.Fatalf("creator name = %q want Alice", created.Name)
	}

	b := h.dial(ctx, t)
	rawJoin, _ := json.Marshal(wire.JoinRoomPayload{Code: created.Code, PublicKey: "PK_B", Name: "  Bob  "})
	writeJSON(t, ctx, b, wire.Envelope{Type: wire.TypeJoinRoom, Payload: rawJoin})
	joined := mustPayload[wire.RoomJoinedPayload](t, readEnvelope(t, ctx, b))
	if joined.Name != "Bob" {
		t.Fatalf("joiner own name = %q want Bob (trimmed)", joined.Name)
	}
	if len(joined.Peers) != 1 || joined.Peers[0].Name != "Alice" {
		t.Fatalf("joined.Peers = %+v want one Alice", joined.Peers)
	}

	pj := mustPayload[wire.PeerJoinedPayload](t, readEnvelope(t, ctx, a))
	if pj.Name != "Bob" {
		t.Fatalf("peer_joined name = %q want Bob", pj.Name)
	}

	// Bob renames himself; both A and B observe peer_renamed.
	renPayload, _ := json.Marshal(wire.RenamePayload{Name: "Robert"})
	writeJSON(t, ctx, b, wire.Envelope{Type: wire.TypeRename, Payload: renPayload})
	for _, conn := range []*websocket.Conn{a, b} {
		env := readEnvelope(t, ctx, conn)
		if env.Type != wire.TypePeerRenamed {
			t.Fatalf("type = %q want peer_renamed", env.Type)
		}
		got := mustPayload[wire.PeerRenamedPayload](t, env)
		if got.PeerID != joined.PeerID || got.Name != "Robert" {
			t.Fatalf("peer_renamed = %+v want id=%q name=Robert", got, joined.PeerID)
		}
	}

	// A new joiner with empty name gets a server-generated fallback and
	// sees the renamed Bob in the peer list.
	c := h.dial(ctx, t)
	rawJoinC, _ := json.Marshal(wire.JoinRoomPayload{Code: created.Code, PublicKey: "PK_C", Name: ""})
	writeJSON(t, ctx, c, wire.Envelope{Type: wire.TypeJoinRoom, Payload: rawJoinC})
	joinedC := mustPayload[wire.RoomJoinedPayload](t, readEnvelope(t, ctx, c))
	if joinedC.Name == "" {
		t.Fatalf("empty-name joiner did not get a server-generated fallback")
	}
	names := map[string]string{}
	for _, p := range joinedC.Peers {
		names[p.ID] = p.Name
	}
	if names[created.PeerID] != "Alice" || names[joined.PeerID] != "Robert" {
		t.Fatalf("peer list names = %+v want Alice + Robert", names)
	}
}

func TestKick(t *testing.T) {
	h := newHarness(t)
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()

	// A creates, B and C join. A kicks C.
	a := h.dial(ctx, t)
	sendCreate(t, ctx, a, "PK_A")
	created := mustPayload[wire.RoomCreatedPayload](t, readEnvelope(t, ctx, a))

	b := h.dial(ctx, t)
	sendJoin(t, ctx, b, created.Code, "PK_B")
	bJoined := mustPayload[wire.RoomJoinedPayload](t, readEnvelope(t, ctx, b))
	_ = readEnvelope(t, ctx, a) // a's peer_joined for B

	c := h.dial(ctx, t)
	sendJoin(t, ctx, c, created.Code, "PK_C")
	cJoined := mustPayload[wire.RoomJoinedPayload](t, readEnvelope(t, ctx, c))
	_ = readEnvelope(t, ctx, a) // a's peer_joined for C
	_ = readEnvelope(t, ctx, b) // b's peer_joined for C

	kickPayload, _ := json.Marshal(wire.KickPayload{PeerID: cJoined.PeerID})
	writeJSON(t, ctx, a, wire.Envelope{Type: wire.TypeKick, Payload: kickPayload})

	// A, B, and C all observe peer_kicked with C as the target and A as the kicker.
	for label, conn := range map[string]*websocket.Conn{"A": a, "B": b, "C": c} {
		env := readEnvelope(t, ctx, conn)
		if env.Type != wire.TypePeerKicked {
			t.Fatalf("%s: type = %q want peer_kicked", label, env.Type)
		}
		got := mustPayload[wire.PeerKickedPayload](t, env)
		if got.PeerID != cJoined.PeerID || got.By != created.PeerID {
			t.Fatalf("%s: peer_kicked = %+v want peerId=%q by=%q", label, got, cJoined.PeerID, created.PeerID)
		}
	}

	// C's WebSocket should close shortly after.
	_, _, err := c.Read(ctx)
	if err == nil {
		t.Fatalf("expected C's read to error after kick")
	}

	// Server peer count drops to two (A and B).
	deadline := time.Now().Add(2 * time.Second)
	for h.server.ActivePeers() != 2 && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
	}
	if got := h.server.ActivePeers(); got != 2 {
		t.Fatalf("ActivePeers = %d, want 2", got)
	}

	// Re-join is permitted: kick is a soft boot, not a ban. Same code, fresh
	// peer ID. The next frame B observes must be peer_joined for cAgain — if
	// the server had emitted a stray peer_left for the kicked C, it would
	// come first and the assertion would catch it.
	cAgain := h.dial(ctx, t)
	sendJoin(t, ctx, cAgain, created.Code, "PK_C2")
	rejoined := mustPayload[wire.RoomJoinedPayload](t, readEnvelope(t, ctx, cAgain))
	if rejoined.Code != created.Code {
		t.Fatalf("rejoin code = %q want %q", rejoined.Code, created.Code)
	}
	if len(rejoined.Peers) != 2 {
		t.Fatalf("rejoin peer count = %d want 2", len(rejoined.Peers))
	}
	bNext := readEnvelope(t, ctx, b)
	if bNext.Type != wire.TypePeerJoined {
		t.Fatalf("B's next frame after peer_kicked = %q, want peer_joined (got a stray peer_left?)", bNext.Type)
	}
	if got := mustPayload[wire.PeerJoinedPayload](t, bNext); got.PeerID != rejoined.PeerID {
		t.Fatalf("B saw peer_joined for %q want %q", got.PeerID, rejoined.PeerID)
	}
	_ = bJoined
}

func TestKickSelfRejected(t *testing.T) {
	h := newHarness(t)
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()

	a := h.dial(ctx, t)
	sendCreate(t, ctx, a, "PK_A")
	created := mustPayload[wire.RoomCreatedPayload](t, readEnvelope(t, ctx, a))

	kickPayload, _ := json.Marshal(wire.KickPayload{PeerID: created.PeerID})
	writeJSON(t, ctx, a, wire.Envelope{Type: wire.TypeKick, Payload: kickPayload})

	env := readEnvelope(t, ctx, a)
	if env.Type != wire.TypeError {
		t.Fatalf("type = %q want error", env.Type)
	}
	if got := mustPayload[wire.ErrorPayload](t, env); got.Code != wire.ErrBadRequest {
		t.Fatalf("code = %q want %q", got.Code, wire.ErrBadRequest)
	}
}

func TestKickUnknownPeer(t *testing.T) {
	h := newHarness(t)
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()

	a := h.dial(ctx, t)
	sendCreate(t, ctx, a, "PK_A")
	_ = readEnvelope(t, ctx, a)

	kickPayload, _ := json.Marshal(wire.KickPayload{PeerID: "nope"})
	writeJSON(t, ctx, a, wire.Envelope{Type: wire.TypeKick, Payload: kickPayload})

	env := readEnvelope(t, ctx, a)
	if env.Type != wire.TypeError {
		t.Fatalf("type = %q want error", env.Type)
	}
	if got := mustPayload[wire.ErrorPayload](t, env); got.Code != wire.ErrPeerNotFound {
		t.Fatalf("code = %q want %q", got.Code, wire.ErrPeerNotFound)
	}
}

func TestRoomEmptyClosesAndCanBeRejoined(t *testing.T) {
	// Long cooldown ensures the freed code isn't simply gc'd and forgotten;
	// the test is about whether an explicit join still works while the
	// cooldown is active (it should — cooldown only blocks random allocation).
	h := newHarness(t, signaling.WithCodeCooldown(time.Hour))
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()

	a := h.dial(ctx, t)
	sendCreate(t, ctx, a, "PK_A")
	created := mustPayload[wire.RoomCreatedPayload](t, readEnvelope(t, ctx, a))

	if err := a.Close(websocket.StatusNormalClosure, ""); err != nil {
		t.Fatalf("close: %v", err)
	}
	// Wait for the server to observe the close and tear the room down.
	deadline := time.Now().Add(2 * time.Second)
	for h.server.ActiveRooms() != 0 && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
	}
	if h.server.ActiveRooms() != 0 {
		t.Fatalf("ActiveRooms = %d, want 0", h.server.ActiveRooms())
	}

	// A peer with the original code can rebuild the room — useful when an
	// errant refresh dropped everyone and they reconnect via the shared link.
	b := h.dial(ctx, t)
	sendJoin(t, ctx, b, created.Code, "PK_B")
	env := readEnvelope(t, ctx, b)
	if env.Type != wire.TypeRoomCreated {
		t.Fatalf("type = %q want %q", env.Type, wire.TypeRoomCreated)
	}
	rejoined := mustPayload[wire.RoomCreatedPayload](t, env)
	if rejoined.Code != created.Code {
		t.Fatalf("code = %q want %q", rejoined.Code, created.Code)
	}
}

