package flow

import (
	"path/filepath"
	"runtime"
	"testing"
)

func TestUnixDoesNotEqualFold(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Windows EqualFold is required")
	}
	a := Canonical("/tmp/FooBar-deck-test")
	b := Canonical("/tmp/foobar-deck-test")
	if SamePath(a, b) {
		t.Fatal("unix must not EqualFold")
	}
	if PathKey(a) == PathKey(b) {
		t.Fatal("unix PathKey must stay case-sensitive")
	}
}

func TestWindowsSlashFoldAndEqualFold(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("slash-fold + EqualFold is Windows-only")
	}
	cases := []struct{ a, b string }{
		{`C:\FlowDeck\Card`, `c:/flowdeck/card`},
		{`C:/FlowDeck/Card`, `C:\FLOWDECK\CARD`},
	}
	for _, tc := range cases {
		if !SamePath(tc.a, tc.b) {
			t.Fatalf("SamePath(%q,%q) = false", tc.a, tc.b)
		}
		if PathKey(tc.a) != PathKey(tc.b) {
			t.Fatalf("PathKey %q vs %q", PathKey(tc.a), PathKey(tc.b))
		}
	}
}

func TestCanonicalSlashFold(t *testing.T) {
	p := Canonical(filepath.Join("a", "b", "c"))
	if filepath.ToSlash(p) != p {
		t.Fatalf("Canonical must slash-fold: %q", p)
	}
}

func TestSamePathSelf(t *testing.T) {
	wd, err := filepath.Abs(".")
	if err != nil {
		t.Fatal(err)
	}
	if !SamePath(wd, wd) {
		t.Fatal("path must equal itself")
	}
	if !SamePath(wd, Canonical(wd)) {
		t.Fatal("Abs vs Canonical")
	}
}
