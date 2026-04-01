/**
 * KiroGraph CLI Banner
 * Displays the KIROGRAPH ASCII art header and a rotating "Did you know?" tip.
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
const figlet = require('figlet');

// ANSI color helpers (no external deps)
const c = {
  reset:  '\x1b[0m',
  bold:   '\x1b[1m',
  dim:    '\x1b[2m',
  purple: '\x1b[38;5;135m',
  violet: '\x1b[38;5;99m',
  cyan:   '\x1b[38;5;117m',
  gray:   '\x1b[90m',
  white:  '\x1b[97m',
};

const TIPS = [
  `Run ${c.cyan}kirograph context "your task"${c.reset} to get relevant code\n  in one shot — no file scanning needed.`,
  `Use ${c.cyan}kirograph query <name>${c.reset} instead of grep.\n  It searches the symbol index instantly.`,
  `${c.cyan}kirograph affected src/foo.ts${c.reset} finds every test file\n  that depends on a changed file — great for CI.`,
  `${c.cyan}kirograph files --format grouped${c.reset} shows your project\n  structure grouped by language from the index.`,
  `${c.cyan}kirograph impact <symbol>${c.reset} shows the blast radius\n  before you change anything.`,
  `Run ${c.cyan}kirograph install${c.reset} once per Kiro workspace to wire up\n  MCP, auto-sync hooks, and steering automatically.`,
  `${c.cyan}kirograph sync${c.reset} is incremental — it only re-parses\n  files whose content has changed since last index.`,
  `Pipe git diff into kirograph:\n  ${c.cyan}git diff --name-only | kirograph affected --stdin${c.reset}`,
];

function pickTip(): string {
  // Rotate daily so it feels fresh but is deterministic
  const idx = Math.floor(Date.now() / 86_400_000) % TIPS.length;
  return TIPS[idx];
}

function boxed(text: string, width = 70): string {
  const lines = text.split('\n');
  const top    = `${c.gray}┌${'─'.repeat(width - 2)}┐${c.reset}`;
  const bottom = `${c.gray}└${'─'.repeat(width - 2)}┘${c.reset}`;
  const padded = lines.map(l => {
    // Strip ANSI for length calculation
    const plain = l.replace(/\x1b\[[0-9;]*m/g, '');
    const pad = Math.max(0, width - 4 - plain.length);
    return `${c.gray}│${c.reset}  ${l}${' '.repeat(pad)}  ${c.gray}│${c.reset}`;
  });
  return [top, ...padded, bottom].join('\n');
}

export function printBanner(): void {
  // ASCII art title
  const art: string = figlet.textSync('KIROGRAPH', { font: 'ANSI Shadow' });

  // Colorize each line of the art in purple/violet gradient
  const artLines = art.split('\n');
  const colored = artLines.map((line, i) => {
    const color = i < artLines.length / 2 ? c.purple : c.violet;
    return `${color}${line}${c.reset}`;
  }).join('\n');

  console.log('\n' + colored);

  // Subtitle
  console.log(`${c.dim}  Semantic code knowledge graph for Kiro — 100% local${c.reset}`);
  console.log(`${c.dim}  Inspired by CodeGraph — original idea by ${c.reset}${c.violet}github.com/colbymchenry${c.reset}\n`);

  // Did you know box
  const label = `${c.gray}─────────────────────── ${c.reset}${c.bold}${c.white}Did you know?${c.reset}${c.gray} ───────────────────────${c.reset}`;
  console.log(label);
  console.log(boxed(pickTip()));
  console.log();
}
