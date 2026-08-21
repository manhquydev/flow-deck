package main

import (
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/manhquydev/flow-deck/internal/flow"
)

func usage(out io.Writer) {
	fmt.Fprint(out, `flow-deck — gate-aware operator dashboard for flow projects

Usage:
  flow-deck status [--flow-bin PATH]
  flow-deck check C-NNN [--flow-bin PATH]

Options:
  --flow-bin PATH  flow.sh / flow.cmd (else FLOW_BIN, else flow.sh on PATH)

Exit codes: 0 ok · 1 error / no project · 2 usage · check relays flow.sh rc
`)
}

type parsed struct {
	help    bool
	unknown string
	flowBin string
	missing bool
	cmd     string
	args    []string
}

func parseArgs(argv []string) parsed {
	p := parsed{}
	var rest []string
	for i := 0; i < len(argv); i++ {
		a := argv[i]
		switch {
		case a == "--help" || a == "-h":
			p.help = true
		case a == "--flow-bin":
			i++
			if i >= len(argv) {
				p.missing = true
				p.unknown = "--flow-bin"
				continue
			}
			p.flowBin = argv[i]
		case strings.HasPrefix(a, "--flow-bin="):
			p.flowBin = strings.TrimPrefix(a, "--flow-bin=")
		case strings.HasPrefix(a, "-"):
			p.unknown = a
		default:
			rest = append(rest, a)
		}
	}
	if len(rest) > 0 {
		p.cmd = rest[0]
		p.args = rest[1:]
	}
	return p
}

func requireRoot() (string, bool) {
	cwd, err := os.Getwd()
	if err != nil {
		fmt.Fprintln(os.Stderr, err.Error())
		return "", false
	}
	root := flow.FindProjectRoot(cwd)
	if root == "" {
		fmt.Fprintln(os.Stderr, flow.NoProjectMessage(cwd))
		return "", false
	}
	return root, true
}

func writeOut(w io.Writer, s string) {
	if s == "" {
		return
	}
	if !strings.HasSuffix(s, "\n") {
		s += "\n"
	}
	fmt.Fprint(w, s)
}

func run(argv []string) int {
	p := parseArgs(argv)
	if p.help || p.cmd == "help" {
		usage(os.Stdout)
		return 0
	}
	if p.unknown != "" {
		if p.missing {
			fmt.Fprintf(os.Stderr, "missing value for %s\n", p.unknown)
		} else {
			fmt.Fprintf(os.Stderr, "unknown option: %s\n", p.unknown)
		}
		usage(os.Stderr)
		return 2
	}
	if p.cmd == "" {
		usage(os.Stderr)
		return 2
	}

	bin := flow.ResolveFlowBin(p.flowBin, "")

	switch p.cmd {
	case "status":
		root, ok := requireRoot()
		if !ok {
			return 1
		}
		board := flow.BoardState(root)
		os.Stdout.WriteString(flow.FormatStatusTable(board))
		return 0
	case "check":
		if len(p.args) < 1 || !flow.IsCardID(p.args[0]) {
			fmt.Fprintln(os.Stderr, "usage: flow-deck check C-NNN")
			return 2
		}
		root, ok := requireRoot()
		if !ok {
			return 1
		}
		result := flow.RunCheck(root, flow.NormalizeCardID(p.args[0]), bin)
		writeOut(os.Stdout, result.Stdout)
		writeOut(os.Stderr, result.Stderr)
		if result.ExecKind != "" && result.ExecKind != "ran" {
			fmt.Fprintf(os.Stderr, "exec %s\n", result.ExecKind)
		}
		if result.CwdUnsafe {
			fmt.Fprintf(os.Stderr, "cwd=root (unsafe)  %s\n", result.Cwd)
		} else {
			fmt.Fprintf(os.Stderr, "cwd=%s\n", result.Cwd)
		}
		return result.RC
	default:
		fmt.Fprintf(os.Stderr, "unknown command: %s\n", p.cmd)
		usage(os.Stderr)
		return 2
	}
}

func main() {
	os.Exit(run(os.Args[1:]))
}
