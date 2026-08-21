package main

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func chdir(t *testing.T, dir string) {
	t.Helper()
	wd, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Chdir(dir); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chdir(wd) })
}

func TestUsageExitCodes(t *testing.T) {
	if code := run(nil); code != 2 {
		t.Fatalf("no args → 2, got %d", code)
	}
	if code := run([]string{"wave"}); code != 2 {
		t.Fatalf("unknown command → 2, got %d", code)
	}
	if code := run([]string{"--port", "9", "status"}); code != 2 {
		t.Fatalf("unknown option → 2, got %d", code)
	}
	if code := run([]string{"--help"}); code != 0 {
		t.Fatalf("help → 0, got %d", code)
	}
	if code := run([]string{"check", "nope"}); code != 2 {
		t.Fatalf("bad id → 2, got %d", code)
	}
}

func TestStatusNoProject(t *testing.T) {
	dir := t.TempDir()
	chdir(t, dir)
	if code := run([]string{"status"}); code != 1 {
		t.Fatalf("no project → 1, got %d", code)
	}
}

func TestStatusAndCheckRelay(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "cards"), 0o755); err != nil {
		t.Fatal(err)
	}
	card := `# C-001 — Tiny

status: todo
deps: none
risk: standard

## Evidence

`
	if err := os.WriteFile(filepath.Join(root, "cards", "C-001.md"), []byte(card), 0o644); err != nil {
		t.Fatal(err)
	}
	bin := filepath.Join(root, "flow.sh")
	script := "#!/usr/bin/env bash\nexit 7\n"
	if runtime.GOOS == "windows" {
		bin = filepath.Join(root, "flow.cmd")
		script = "@echo off\r\nexit /b 7\r\n"
	}
	if err := os.WriteFile(bin, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	if runtime.GOOS != "windows" {
		if err := os.Chmod(bin, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	chdir(t, root)
	if code := run([]string{"status", "--flow-bin", bin}); code != 0 {
		t.Fatalf("status → 0, got %d", code)
	}
	if code := run([]string{"check", "C-001", "--flow-bin", bin}); code != 7 {
		t.Fatalf("check relays rc, got %d", code)
	}
}
