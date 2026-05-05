// Package wire defines the wisp signaling protocol: room codes plus the JSON
// control frames exchanged between browser clients and the signaling server.
package wire

import (
	"crypto/rand"
	"encoding/binary"
	"fmt"
	"strings"
)

// Code is the user-visible room identifier "<adjective>-<noun>"
// (e.g. "velvet-otter"). Speakable over voice; case-insensitive on parse.
type Code struct {
	Adjective string
	Noun      string
}

// String renders the canonical lower-case form.
func (c Code) String() string {
	return fmt.Sprintf("%s-%s", c.Adjective, c.Noun)
}

// FormatCode draws an adjective and a noun uniformly at random.
// Reads 4 bytes from crypto/rand. Allocates without checking the active
// room map: the signaling server retries on collision.
func FormatCode() (Code, error) {
	var buf [4]byte
	if _, err := rand.Read(buf[:]); err != nil {
		return Code{}, fmt.Errorf("reading random bytes: %w", err)
	}
	return Code{
		Adjective: Adjectives[binary.BigEndian.Uint16(buf[0:2])%uint16(len(Adjectives))],
		Noun:      Nouns[binary.BigEndian.Uint16(buf[2:4])%uint16(len(Nouns))],
	}, nil
}

// ParseCode accepts "adjective-noun" in any case. Wordlists are not
// validated here — a typo surfaces as a "room not found" error from the
// signaling server, which is what the user sees anyway.
func ParseCode(s string) (Code, error) {
	parts := strings.Split(strings.ToLower(strings.TrimSpace(s)), "-")
	if len(parts) != 2 {
		return Code{}, fmt.Errorf("invalid code %q: want adjective-noun", s)
	}
	for i, p := range parts {
		if p == "" {
			return Code{}, fmt.Errorf("invalid code %q: empty word in slot %d", s, i)
		}
	}
	return Code{Adjective: parts[0], Noun: parts[1]}, nil
}
