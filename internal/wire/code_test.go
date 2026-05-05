package wire_test

import (
	"slices"
	"strings"
	"testing"

	"github.com/danielmmetz/wisp/internal/wire"
)

func TestFormatCodeRoundTrip(t *testing.T) {
	for range 64 {
		c, err := wire.FormatCode()
		if err != nil {
			t.Fatalf("FormatCode: %v", err)
		}
		got, err := wire.ParseCode(c.String())
		if err != nil {
			t.Fatalf("ParseCode(%q): %v", c.String(), err)
		}
		if got != c {
			t.Fatalf("round trip lost data: got %+v want %+v", got, c)
		}
	}
}

func TestFormatCodeShape(t *testing.T) {
	c, err := wire.FormatCode()
	if err != nil {
		t.Fatal(err)
	}
	parts := strings.Split(c.String(), "-")
	if len(parts) != 2 {
		t.Fatalf("expected 2 parts, got %d in %q", len(parts), c.String())
	}
	if !slices.Contains(wire.Adjectives, c.Adjective) {
		t.Fatalf("adjective %q not in wordlist", c.Adjective)
	}
	if !slices.Contains(wire.Nouns, c.Noun) {
		t.Fatalf("noun %q not in wordlist", c.Noun)
	}
}

func TestParseCode(t *testing.T) {
	cases := []struct {
		in      string
		want    wire.Code
		wantErr bool
	}{
		{"velvet-otter", wire.Code{Adjective: "velvet", Noun: "otter"}, false},
		{"VELVET-OTTER", wire.Code{Adjective: "velvet", Noun: "otter"}, false},
		{"  velvet-otter  ", wire.Code{Adjective: "velvet", Noun: "otter"}, false},
		{"", wire.Code{}, true},
		{"velvet", wire.Code{}, true},
		{"velvet-otter-42", wire.Code{}, true},
		{"velvet-", wire.Code{}, true},
		{"-otter", wire.Code{}, true},
	}
	for _, tc := range cases {
		got, err := wire.ParseCode(tc.in)
		if tc.wantErr {
			if err == nil {
				t.Errorf("ParseCode(%q): want error, got %+v", tc.in, got)
			}
			continue
		}
		if err != nil {
			t.Errorf("ParseCode(%q): unexpected error %v", tc.in, err)
			continue
		}
		if got != tc.want {
			t.Errorf("ParseCode(%q) = %+v, want %+v", tc.in, got, tc.want)
		}
	}
}

func TestNoEmptyWords(t *testing.T) {
	for _, w := range wire.Adjectives {
		if w == "" || strings.Contains(w, "-") || strings.Contains(w, " ") {
			t.Errorf("bad adjective %q", w)
		}
	}
	for _, w := range wire.Nouns {
		if w == "" || strings.Contains(w, "-") || strings.Contains(w, " ") {
			t.Errorf("bad noun %q", w)
		}
	}
}

func TestAdjectivesAndNounsDisjoint(t *testing.T) {
	nouns := make(map[string]struct{}, len(wire.Nouns))
	for _, n := range wire.Nouns {
		nouns[n] = struct{}{}
	}
	for _, a := range wire.Adjectives {
		if _, dup := nouns[a]; dup {
			t.Errorf("%q appears in both Adjectives and Nouns", a)
		}
	}
}

