//go:build !windows

package flow

import "syscall"

func sysProcAttr() *syscall.SysProcAttr {
	return nil
}

func needsArgAllowlist(string) bool {
	return false
}
