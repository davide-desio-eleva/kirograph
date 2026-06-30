import { execSync, spawnSync } from 'child_process';
import { Command } from 'commander';

function detectInstaller(): 'npm' | 'bun' | 'pnpm' | 'yarn' | 'unknown' {
  try {
    const npmOut = execSync('npm list -g --depth=0 kirograph 2>/dev/null', { stdio: 'pipe' }).toString();
    if (npmOut.includes('kirograph')) return 'npm';
  } catch { /* */ }
  try {
    const bunOut = execSync('bun pm ls -g 2>/dev/null | grep kirograph', { stdio: 'pipe' }).toString();
    if (bunOut.includes('kirograph')) return 'bun';
  } catch { /* */ }
  try {
    const pnpmOut = execSync('pnpm list -g --depth=0 kirograph 2>/dev/null', { stdio: 'pipe' }).toString();
    if (pnpmOut.includes('kirograph')) return 'pnpm';
  } catch { /* */ }
  return 'unknown';
}

export function register(program: Command): void {
  program.command('upgrade')
    .description('Update KiroGraph to the latest version')
    .option('--dry-run', 'Show what would be run without executing')
    .action((opts: { dryRun?: boolean }) => {
      const installer = detectInstaller();
      const commands: Record<string, string> = {
        npm: 'npm update -g kirograph',
        bun: 'bun update -g kirograph',
        pnpm: 'pnpm update -g kirograph',
        yarn: 'yarn global upgrade kirograph',
      };

      if (installer === 'unknown') {
        console.log('  Could not detect package manager. Try one of:');
        for (const [mgr, cmd] of Object.entries(commands)) {
          console.log('    ' + mgr + ': ' + cmd);
        }
        return;
      }

      const cmd = commands[installer];
      console.log('  Detected installer: ' + installer);
      console.log('  Running: ' + cmd);

      if (opts.dryRun) {
        console.log('  (dry run — not executing)');
        return;
      }

      const result = spawnSync(cmd.split(' ')[0], cmd.split(' ').slice(1), { stdio: 'inherit' });
      if (result.status !== 0) {
        console.error('  Upgrade failed (exit ' + result.status + ')');
        process.exit(result.status ?? 1);
      }
      console.log('  Done.');
    });
}
