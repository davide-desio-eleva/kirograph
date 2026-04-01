/**
 * KiroGraph Installer — interactive prompt helpers
 */

import * as readline from 'readline';

// ── ANSI ──────────────────────────────────────────────────────────────────────

export const violet = '\x1b[38;5;99m';
export const reset  = '\x1b[0m';
export const dim    = '\x1b[2m';
const bold          = '\x1b[1m';
const green         = '\x1b[32m';

// ── Primitives ────────────────────────────────────────────────────────────────

export function ask(rl: readline.Interface, question: string): Promise<string> {
  return new Promise(resolve => rl.question(question, resolve));
}

/**
 * Prompt a yes/no question, re-prompting on invalid input.
 * Accepts: "" (use default), "y", "Y", "n", "N".
 */
export async function askBool(
  rl: readline.Interface,
  question: string,
  description: string,
  defaultYes = true,
): Promise<boolean> {
  const hint = defaultYes ? 'Y/n' : 'y/N';
  console.log(`\n  ${dim}${description}${reset}`);
  while (true) {
    const raw = await ask(rl, `  ${violet}${question}${reset} ${dim}(${hint})${reset} `);
    if (raw === '') return defaultYes;
    if (raw === 'y' || raw === 'Y') return true;
    if (raw === 'n' || raw === 'N') return false;
    console.log(`  Please enter y or n.`);
  }
}

/**
 * Prompt for a string value, returning the default on empty input.
 */
export async function askString(
  rl: readline.Interface,
  question: string,
  description: string,
  defaultValue: string,
): Promise<string> {
  console.log(`\n  ${dim}${description}${reset}`);
  const raw = await ask(rl, `  ${violet}${question}${reset} ${dim}(${defaultValue})${reset} `);
  return raw === '' ? defaultValue : raw;
}

/**
 * Interactive arrow-key selection menu.
 * Temporarily pauses the readline interface to take over raw stdin,
 * then resumes it when done so subsequent prompts work normally.
 */
export async function arrowSelect<T>(
  rl: readline.Interface,
  label: string,
  options: Array<{ value: T; label: string; description: string }>,
  defaultIndex = 0,
): Promise<T> {
  const CURSOR_UP   = '\x1b[A';
  const CURSOR_DOWN = '\x1b[B';
  const CLEAR_LINE  = '\x1b[2K\x1b[G';

  let selected = defaultIndex;

  function render(first: boolean) {
    if (!first) {
      process.stdout.write(`\x1b[${options.length + 1}A`);
    }
    for (let i = 0; i < options.length; i++) {
      const active = i === selected;
      const cursor = active ? `${green}${bold}❯${reset}` : ' ';
      const text   = active ? `${bold}${options[i]!.label}${reset}` : `${dim}${options[i]!.label}${reset}`;
      process.stdout.write(`${CLEAR_LINE}  ${cursor} ${text}\n`);
    }
    const desc = options[selected]!.description;
    process.stdout.write(`${CLEAR_LINE}  ${dim}${desc}${reset}\n`);
  }

  return new Promise(resolve => {
    console.log(`\n  ${violet}${label}${reset}`);
    render(true);

    rl.pause();
    const stdin = process.stdin;
    const wasTTY = stdin.isTTY;
    if (wasTTY) stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');

    function onData(key: string) {
      if (key === CURSOR_UP || key === '\x1b[A') {
        selected = (selected - 1 + options.length) % options.length;
        render(false);
      } else if (key === CURSOR_DOWN || key === '\x1b[B') {
        selected = (selected + 1) % options.length;
        render(false);
      } else if (key === '\r' || key === '\n' || key === ' ') {
        stdin.removeListener('data', onData);
        if (wasTTY) stdin.setRawMode(false);
        stdin.pause();
        rl.resume();
        process.stdout.write(`\x1b[${options.length + 1}A`);
        for (let i = 0; i < options.length; i++) {
          const active = i === selected;
          const cursor = active ? `${green}${bold}❯${reset}` : ' ';
          const text   = active ? `${green}${bold}${options[i]!.label}${reset}` : `${dim}${options[i]!.label}${reset}`;
          process.stdout.write(`${CLEAR_LINE}  ${cursor} ${text}\n`);
        }
        process.stdout.write(`${CLEAR_LINE}\n`);
        resolve(options[selected]!.value);
      } else if (key === '\x03') {
        stdin.removeListener('data', onData);
        if (wasTTY) stdin.setRawMode(false);
        process.exit(1);
      }
    }

    stdin.on('data', onData);
  });
}
