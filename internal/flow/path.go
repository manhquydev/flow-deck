package flow

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

// Canonical returns one spelling: EvalSymlinks, slash-fold, Windows long-prefix stripped.
// Missing paths still Abs+Clean+slash-fold.
func Canonical(p string) string {
	if p == "" {
		return ""
	}
	abs, err := filepath.Abs(p)
	if err != nil {
		abs = filepath.Clean(p)
	}
	if eval, err := filepath.EvalSymlinks(abs); err == nil {
		abs = eval
	}
	abs = filepath.Clean(abs)
	abs = stripWinLongPrefix(abs)
	return filepath.ToSlash(abs)
}

func stripWinLongPrefix(p string) string {
	const (
		unc  = `\\?\UNC\`
		long = `\\?\`
	)
	switch {
	case strings.HasPrefix(p, unc):
		return `\\` + p[len(unc):]
	case strings.HasPrefix(p, long):
		return p[len(long):]
	case strings.HasPrefix(p, `//?/UNC/`):
		return `//` + p[len(`//?/UNC/`):]
	case strings.HasPrefix(p, `//?/`):
		return p[len(`//?/`):]
	}
	return p
}

// SamePath reports whether a and b name the same location.
// EqualFold is Windows-only; Unix comparison is case-sensitive.
func SamePath(a, b string) bool {
	ca, cb := Canonical(a), Canonical(b)
	if ca == "" || cb == "" {
		return false
	}
	if runtime.GOOS == "windows" {
		return strings.EqualFold(ca, cb)
	}
	return ca == cb
}

// PathKey is a map key for a filesystem path. Lowercased only on Windows.
func PathKey(p string) string {
	c := Canonical(p)
	if runtime.GOOS == "windows" {
		return strings.ToLower(c)
	}
	return c
}

func isDir(p string) bool {
	if p == "" {
		return false
	}
	st, err := os.Stat(p)
	return err == nil && st.IsDir()
}

func isFile(p string) bool {
	if p == "" {
		return false
	}
	st, err := os.Stat(p)
	return err == nil && st.Mode().IsRegular()
}

func readText(p string) string {
	b, err := os.ReadFile(p)
	if err != nil {
		return ""
	}
	return string(b)
}
