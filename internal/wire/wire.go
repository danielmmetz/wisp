package wire

import (
	"crypto/rand"
	"encoding/binary"
	"encoding/json"
	"strings"
	"unicode/utf8"
)

// NormalizeName trims, length-caps, and falls back to a random animal name
// when the input is empty after trimming. Returns a name safe to broadcast.
func NormalizeName(s string) string {
	s = strings.TrimSpace(s)
	if s == "" {
		return RandomAnimalName()
	}
	if utf8.RuneCountInString(s) > MaxNameLen {
		runes := []rune(s)
		s = string(runes[:MaxNameLen])
	}
	return s
}

// RandomAnimalName picks a random noun from the room-code wordlist. Used as
// the server-side fallback when a peer joins without a name.
func RandomAnimalName() string {
	var buf [2]byte
	if _, err := rand.Read(buf[:]); err != nil {
		return Nouns[0]
	}
	return Nouns[binary.BigEndian.Uint16(buf[:])%uint16(len(Nouns))]
}

// Op constants for control-frame envelopes. Both directions use the same
// envelope shape: {"type": "...", "payload": {...}}.
const (
	// Client → server.
	TypeCreateRoom = "create_room"
	TypeJoinRoom   = "join_room"
	TypeLeaveRoom  = "leave_room"
	TypeRename     = "rename"
	TypeSignal     = "signal"

	// Server → client.
	TypeRoomCreated = "room_created"
	TypeRoomJoined  = "room_joined"
	TypePeerJoined  = "peer_joined"
	TypePeerLeft    = "peer_left"
	TypePeerRenamed = "peer_renamed"
	TypeError       = "error"
)

// MaxNameLen bounds display names. Long enough to fit "Captain Awesome of
// the Northern Reach" but short enough that one peer can't push the row
// layout off-screen. Trimmed before length-check; empty names are replaced
// server-side with a generated animal name.
const MaxNameLen = 32

// Error codes returned in ErrorPayload.Code.
const (
	ErrBadRequest    = "bad_request"
	ErrRateLimited   = "rate_limited"
	ErrRoomNotFound  = "room_not_found"
	ErrRoomFull      = "room_full"
	ErrRoomGenFailed = "room_gen_failed"
	ErrPeerNotFound  = "peer_not_found"
	ErrCapacity      = "capacity"
	ErrInternal      = "internal"
)

// Envelope wraps every control frame on the wire. The server unmarshals
// Type, then unmarshals Payload into the type-specific struct below.
type Envelope struct {
	Type    string          `json:"type"`
	Payload json.RawMessage `json:"payload,omitempty"`
}

// Client → server payloads.

type CreateRoomPayload struct {
	// PublicKey is the joining peer's ephemeral X25519 public key, base64
	// (raw, no padding). Other peers in the room use it to encrypt the
	// group-key handoff for this peer.
	PublicKey string `json:"publicKey"`
	// SupportsE2EE is true when the client can run the WebRTC Insertable
	// Streams transform. Server propagates it to other peers; per-pair E2EE
	// activates iff both peers report support.
	SupportsE2EE bool `json:"supportsE2EE"`
	// Name is the user-chosen display name. Trimmed and length-capped
	// server-side; empty falls back to a generated animal name.
	Name string `json:"name,omitempty"`
}

type JoinRoomPayload struct {
	Code         string `json:"code"`
	PublicKey    string `json:"publicKey"`
	SupportsE2EE bool   `json:"supportsE2EE"`
	Name         string `json:"name,omitempty"`
}

type RenamePayload struct {
	Name string `json:"name"`
}

type SignalPayload struct {
	// To is the destination peer ID within the room.
	To string `json:"to"`
	// Data is opaque to the server; carries SDP offers/answers and ICE
	// candidates. The server passes it through verbatim.
	Data json.RawMessage `json:"data"`
}

// Server → client payloads.

// PeerInfo is the per-peer metadata shared with a joiner so it can begin
// dialing existing members.
type PeerInfo struct {
	ID           string `json:"id"`
	PublicKey    string `json:"publicKey"`
	SupportsE2EE bool   `json:"supportsE2EE"`
	Name         string `json:"name"`
}

type RoomCreatedPayload struct {
	Code   string     `json:"code"`
	PeerID string     `json:"peerId"`
	Name   string     `json:"name"`
	TURN   *TurnCreds `json:"turn,omitempty"`
}

type RoomJoinedPayload struct {
	Code   string     `json:"code"`
	PeerID string     `json:"peerId"`
	Name   string     `json:"name"`
	Peers  []PeerInfo `json:"peers"`
	TURN   *TurnCreds `json:"turn,omitempty"`
}

type PeerJoinedPayload struct {
	PeerID       string `json:"peerId"`
	PublicKey    string `json:"publicKey"`
	SupportsE2EE bool   `json:"supportsE2EE"`
	Name         string `json:"name"`
}

type PeerLeftPayload struct {
	PeerID string `json:"peerId"`
}

type PeerRenamedPayload struct {
	PeerID string `json:"peerId"`
	Name   string `json:"name"`
}

// SignalForwardedPayload is the server-side rewrite of SignalPayload: To
// becomes From so the recipient knows who sent it. Data is opaque to the
// server and carries SDP/ICE plus E2EE group-key handoffs.
type SignalForwardedPayload struct {
	From string          `json:"from"`
	Data json.RawMessage `json:"data"`
}

type ErrorPayload struct {
	Code    string `json:"code"`
	Message string `json:"message,omitempty"`
}

// TurnCreds carries short-term TURN credentials per-peer (Cloudflare binds
// each Allocate to one credential, so we mint a fresh one per joiner).
type TurnCreds struct {
	URIs       []string `json:"uris"`
	Username   string   `json:"username"`
	Credential string   `json:"credential"`
	TTL        int      `json:"ttl"`
}
