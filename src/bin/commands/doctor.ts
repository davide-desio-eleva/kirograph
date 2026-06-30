import { Command } from 'commander';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { dim, reset, green, bold, section, label } from '../ui';

const RED   = '\x1b[38;5;203m';
const YELLOW = '\x1b[38;5;227m';

type CheckStatus = 'ok' | 'warn' | 'fail' | 'skip';

interface Check {
  name: string;
  status: CheckStatus;
  message: string;
  fix?: () => void;
}

function pass(name: string, message: string): Check { return { name, status: 'ok', message }; }
function warn(name: string, message: string, fix?: () => void): Check { return { name, status: 'warn', message, fix }; }
function fail(name: string, message: string, fix?: () => void): Check { return { name, status: 'fail', message, fix }; }
function skip(name: string, message: string): Check { return { name, status: 'skip', message }; }

function statusIcon(s: CheckStatus): string {
  if (s === 'ok')   return `${green}✓${reset}`;
  if (s === 'warn') return `${YELLOW}⚠${reset}`;
  if (s === 'fail') return `${RED}✖${reset}`;
  return `${dim}–${reset}`;
}

export function register(program: Command): void {
  program
    .command('doctor [projectPath]')
    .description('Health check: index, config, hooks, and permissions')
    .option('--fix', 'Auto-repair fixable issues (hook permissions, stale lock file)')
    .action(async (projectPath: string | undefined, opts: { fix?: boolean }) => {
      const target = path.resolve(projectPath ?? process.cwd());
      const kirographDir = path.join(target, '.kirograph');
      const dbPath = path.join(kirographDir, 'kirograph.db');
      const lockPath = path.join(kirographDir, 'kirograph.lock');
      const configPath = path.join(kirographDir, 'config.json');
      const globalDir = path.join(os.homedir(), '.kirograph');
      const hooksDir = path.join(target, '.kiro', 'hooks');

      const checks: Check[] = [];

      // ── Index ────────────────────────────────────────────────────────────────
      if (!fs.existsSync(kirographDir)) {
        checks.push(fail('index dir', `.kirograph/ not found — run \`kirograph init\``));
      } else {
        checks.push(pass('index dir', `.kirograph/ exists`));

        if (!fs.existsSync(dbPath)) {
          checks.push(fail('database', `kirograph.db not found — run \`kirograph index\``));
        } else {
          const stat = fs.statSync(dbPath);
          const sizeMB = (stat.size / 1_048_576).toFixed(1);
          checks.push(pass('database', `kirograph.db present (${sizeMB} MB)`));
        }

        // Stale lock
        if (fs.existsSync(lockPath)) {
          const lockContent = fs.readFileSync(lockPath, 'utf8').trim();
          checks.push(warn('lock file', `Stale lock held by: ${lockContent}`,
            opts.fix ? () => { fs.unlinkSync(lockPath); } : undefined));
        } else {
          checks.push(pass('lock file', 'no stale lock'));
        }

        // Config validity
        if (!fs.existsSync(configPath)) {
          checks.push(skip('config', 'config.json not found (using defaults)'));
        } else {
          try {
            JSON.parse(fs.readFileSync(configPath, 'utf8'));
            checks.push(pass('config', 'config.json is valid JSON'));
          } catch (e) {
            checks.push(fail('config', `config.json parse error: ${(e as Error).message}`));
          }
        }

        // Permissions
        try {
          fs.accessSync(kirographDir, fs.constants.W_OK);
          checks.push(pass('permissions', '.kirograph/ is writable'));
        } catch {
          const fix = opts.fix
            ? () => { try { fs.chmodSync(kirographDir, 0o755); } catch { /* ignore */ } }
            : undefined;
          checks.push(fail('permissions', '.kirograph/ is not writable', fix));
        }
      }

      // ── Global store ─────────────────────────────────────────────────────────
      if (!fs.existsSync(globalDir)) {
        checks.push(skip('global store', `~/.kirograph/ not found (created on first \`kirograph hook save\`)`));
      } else {
        checks.push(pass('global store', `~/.kirograph/ exists`));
        const globalDb = path.join(globalDir, 'kirograph.db');
        if (fs.existsSync(globalDb)) {
          const stat = fs.statSync(globalDb);
          checks.push(pass('global db', `~/.kirograph/kirograph.db (${(stat.size / 1_048_576).toFixed(1)} MB)`));
        }
      }

      // ── Hooks ────────────────────────────────────────────────────────────────
      if (!fs.existsSync(hooksDir)) {
        checks.push(skip('hooks', '.kiro/hooks/ not found (no workspace hooks installed)'));
      } else {
        let hookFiles: string[] = [];
        try {
          hookFiles = fs.readdirSync(hooksDir).filter(f => f.endsWith('.kiro.hook'));
        } catch {
          checks.push(fail('hooks', '.kiro/hooks/ is not readable'));
        }
        if (hookFiles.length > 0) {
          const brokenHooks: string[] = [];
          for (const hf of hookFiles) {
            const hp = path.join(hooksDir, hf);
            try {
              JSON.parse(fs.readFileSync(hp, 'utf8'));
            } catch {
              brokenHooks.push(hf);
            }
          }
          if (brokenHooks.length > 0) {
            checks.push(warn('hooks', `${brokenHooks.length} hook file(s) have invalid JSON: ${brokenHooks.join(', ')}`));
          } else {
            checks.push(pass('hooks', `${hookFiles.length} hook file(s) valid`));
          }
        } else {
          checks.push(skip('hooks', '.kiro/hooks/ empty (no hooks installed)'));
        }
      }

      // ── Binary ───────────────────────────────────────────────────────────────
      const { execSync } = await import('child_process');
      try {
        const which = execSync('which kirograph 2>/dev/null || where kirograph 2>nul', { encoding: 'utf8' }).trim();
        checks.push(pass('binary', `kirograph found at ${which}`));
      } catch {
        checks.push(warn('binary', 'kirograph not found in PATH — install via `npm install -g kirograph`'));
      }

      // ── Apply fixes ──────────────────────────────────────────────────────────
      const fixable = checks.filter(c => c.status !== 'ok' && c.fix);
      if (opts.fix && fixable.length > 0) {
        for (const c of fixable) {
          try {
            c.fix!();
            c.status = 'ok';
            c.message += ' (fixed)';
          } catch (e) {
            c.message += ` (fix failed: ${(e as Error).message})`;
          }
        }
      }

      // ── Print results ────────────────────────────────────────────────────────
      console.log();
      console.log(section('  KiroGraph Doctor'));
      console.log(`  ${dim}Project: ${target}${reset}`);
      console.log();

      const maxNameLen = Math.max(...checks.map(c => c.name.length));
      for (const c of checks) {
        const icon = statusIcon(c.status);
        const name = c.name.padEnd(maxNameLen);
        const canFix = c.fix && !opts.fix ? `  ${dim}(pass --fix to repair)${reset}` : '';
        console.log(`  ${icon}  ${label(name)}  ${c.message}${canFix}`);
      }

      const fails = checks.filter(c => c.status === 'fail').length;
      const warns = checks.filter(c => c.status === 'warn').length;
      console.log();
      if (fails === 0 && warns === 0) {
        console.log(`  ${green}${bold}All checks passed.${reset}`);
      } else {
        if (fails > 0) console.log(`  ${RED}${fails} check(s) failed.${reset}`);
        if (warns > 0) console.log(`  ${YELLOW}${warns} warning(s).${reset}`);
        if (!opts.fix && fixable.length > 0) {
          console.log(`  ${dim}Run \`kirograph doctor --fix\` to auto-repair ${fixable.length} issue(s).${reset}`);
        }
        process.exitCode = fails > 0 ? 1 : 0;
      }
      console.log();
    });
}
