#!/usr/bin/env node
/**
 * flow-deck CLI — dashboard for flow projects. Not a terminal. Not flow.
 */
import {
  boardState,
  DEFAULT_PORT,
  findProjectRoot,
  formatStatusTable,
  formatWaveText,
  isCardId,
  noProjectMessage,
  normalizeCardId,
  resolveFlowBin,
  runCheck,
  waveState,
} from "./lib/flow.mjs";
import { serveDeck } from "./server.mjs";

function usage(out = console.log) {
  out(`flow-deck — gate-aware operator dashboard for flow projects

Usage:
  flow-deck serve [--port N] [--flow-bin PATH]
  flow-deck status [--flow-bin PATH]
  flow-deck check C-NNN [--flow-bin PATH]
  flow-deck wave [--flow-bin PATH]

Options:
  --port N         bind port (default ${DEFAULT_PORT}); host is always 127.0.0.1
  --flow-bin PATH  flow.sh / flow.cmd (else FLOW_BIN, else flow.sh on PATH)

Exit codes: 0 ok · 1 error / no project · 2 usage · check relays flow.sh rc
`);
}

function parseArgs(argv) {
  const flags = { port: DEFAULT_PORT, flowBin: undefined };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") {
      flags.help = true;
    } else if (a === "--port") {
      flags.port = Number(argv[++i]);
    } else if (a.startsWith("--port=")) {
      flags.port = Number(a.slice("--port=".length));
    } else if (a === "--flow-bin") {
      flags.flowBin = argv[++i];
    } else if (a.startsWith("--flow-bin=")) {
      flags.flowBin = a.slice("--flow-bin=".length);
    } else if (a.startsWith("-")) {
      flags.unknown = a;
    } else {
      rest.push(a);
    }
  }
  return { flags, cmd: rest[0] || "", args: rest.slice(1) };
}

function requireRoot() {
  const root = findProjectRoot(process.cwd());
  if (!root) {
    console.error(noProjectMessage(process.cwd()));
    process.exit(1);
  }
  return root;
}

async function main(argv = process.argv.slice(2)) {
  const { flags, cmd, args } = parseArgs(argv);
  if (flags.help || cmd === "help") {
    usage();
    return 0;
  }
  if (flags.unknown) {
    console.error(`unknown option: ${flags.unknown}`);
    usage(console.error);
    return 2;
  }
  if (flags.port !== undefined && (!Number.isFinite(flags.port) || flags.port <= 0)) {
    console.error("invalid --port");
    return 2;
  }

  const flowBin = resolveFlowBin(flags.flowBin);

  if (!cmd) {
    usage(console.error);
    return 2;
  }

  if (cmd === "serve") {
    const root = findProjectRoot(process.cwd());
    const deck = await serveDeck({
      port: flags.port,
      flowBin,
      cwd: process.cwd(),
      root: root || undefined,
    });
    const addr = deck.server.address();
    const port = typeof addr === "object" && addr ? addr.port : flags.port;
    console.log(`flow-deck  http://127.0.0.1:${port}`);
    if (root) console.log(`project    ${root}`);
    else console.log("project    (none — open a flow project, then refresh)");
    console.log(`flow-bin   ${flowBin}`);
    console.log("^C to quit");
    await new Promise(() => {});
  }

  if (cmd === "status") {
    const root = requireRoot();
    const board = boardState(root);
    process.stdout.write(formatStatusTable(board));
    return 0;
  }

  if (cmd === "check") {
    const id = args[0];
    if (!isCardId(id)) {
      console.error("usage: flow-deck check C-NNN");
      return 2;
    }
    const root = requireRoot();
    const result = runCheck(root, normalizeCardId(id), flowBin);
    if (result.stdout) process.stdout.write(result.stdout.endsWith("\n") ? result.stdout : result.stdout + "\n");
    if (result.stderr) process.stderr.write(result.stderr.endsWith("\n") ? result.stderr : result.stderr + "\n");
    if (result.cwdUnsafe) {
      console.error(`cwd=root (unsafe)  ${result.cwd}`);
    } else {
      console.error(`cwd=${result.cwd}`);
    }
    return typeof result.rc === "number" ? result.rc : 1;
  }

  if (cmd === "wave") {
    const root = requireRoot();
    const wave = waveState(root, flowBin);
    process.stdout.write(formatWaveText(wave));
    return 0;
  }

  console.error(`unknown command: ${cmd}`);
  usage(console.error);
  return 2;
}

const exitCode = await main();
if (typeof exitCode === "number") process.exit(exitCode);
