import { Command } from 'commander';
import * as path from 'path';
import * as fs from 'fs';
import { dim, reset, green, bold, section, label } from '../ui';

export function register(program: Command): void {
  program
    .command('manifest [projectPath]')
    .description('Workspace manifest summary: packages, versions, licenses, and version drift')
    .option('--package <name>', 'Drill into a specific package (partial name match)')
    .option('--ecosystem <lang>', 'Filter by ecosystem/language (npm, cargo, go, python, maven, gradle)')
    .option('--drift', 'Show packages with version drift across manifests')
    .action(async (projectPath: string | undefined, opts: { package?: string; ecosystem?: string; drift?: boolean }) => {
      const target = path.resolve(projectPath ?? process.cwd());

      const { parseAllManifests } = await import('../../architecture/manifest/index');
      let packages = await parseAllManifests(target);

      if (packages.length === 0) {
        console.log(`\n  ${dim}No manifest packages found in ${target}${reset}`);
        console.log(`  ${dim}Run \`kirograph index\` first or check your project root.${reset}\n`);
        return;
      }

      // Read license fields from manifest files
      const licenseMap = new Map<string, string>();
      for (const pkg of packages) {
        if (!pkg.manifestPath) continue;
        const absManifest = path.join(target, pkg.manifestPath);
        try {
          const basename = path.basename(absManifest);
          if (basename === 'package.json') {
            const raw = JSON.parse(fs.readFileSync(absManifest, 'utf8')) as Record<string, unknown>;
            if (typeof raw.license === 'string') licenseMap.set(pkg.id, raw.license);
          } else if (basename === 'Cargo.toml') {
            const content = fs.readFileSync(absManifest, 'utf8');
            const m = content.match(/^\s*license\s*=\s*"([^"]+)"/m);
            if (m) licenseMap.set(pkg.id, m[1]);
          } else if (basename === 'pyproject.toml') {
            const content = fs.readFileSync(absManifest, 'utf8');
            const m = content.match(/^\s*license\s*=\s*"([^"]+)"/m);
            if (m) licenseMap.set(pkg.id, m[1]);
          }
        } catch { /* ignore */ }
      }

      // Filter by ecosystem
      if (opts.ecosystem) {
        const filter = opts.ecosystem.toLowerCase();
        packages = packages.filter(p =>
          p.language?.toLowerCase().includes(filter) ||
          (p.manifestPath?.toLowerCase().includes(filter))
        );
      }

      // Drill into a specific package
      if (opts.package) {
        const query = opts.package.toLowerCase();
        const pkg = packages.find(p =>
          p.name.toLowerCase().includes(query) ||
          p.path.toLowerCase().includes(query) ||
          p.id.toLowerCase().includes(query)
        );
        if (!pkg) {
          console.error(`  Package "${opts.package}" not found. Run \`kirograph manifest\` to list all packages.`);
          process.exit(1);
        }

        console.log();
        console.log(section(`  ${pkg.name}`));
        console.log(`  ${label('ID')}       ${pkg.id}`);
        console.log(`  ${label('Path')}     ${pkg.path}`);
        console.log(`  ${label('Source')}   ${pkg.source}${pkg.manifestPath ? ` (${pkg.manifestPath})` : ''}`);
        if (pkg.version)  console.log(`  ${label('Version')}  ${pkg.version}`);
        if (pkg.language) console.log(`  ${label('Language')} ${pkg.language}`);
        if (licenseMap.has(pkg.id)) console.log(`  ${label('License')}  ${licenseMap.get(pkg.id)}`);

        if (pkg.externalDeps && pkg.externalDeps.length > 0) {
          console.log();
          console.log(`  ${label('External deps')} (${pkg.externalDeps.length})`);
          for (const dep of pkg.externalDeps) {
            console.log(`    ${dim}·${reset} ${dep}`);
          }
        }
        console.log();
        return;
      }

      // Version drift
      if (opts.drift) {
        const byName = new Map<string, Array<{ version?: string; path: string }>>();
        for (const pkg of packages) {
          const key = pkg.name.toLowerCase();
          if (!byName.has(key)) byName.set(key, []);
          byName.get(key)!.push({ version: pkg.version, path: pkg.path });
        }
        const drifted = [...byName.entries()].filter(([, entries]) => {
          const versions = new Set(entries.map(e => e.version).filter(Boolean));
          return entries.length > 1 && versions.size > 1;
        });

        console.log();
        if (drifted.length === 0) {
          console.log(`  ${green}✓${reset}  No version drift detected.`);
        } else {
          console.log(section(`  Version Drift (${drifted.length} package${drifted.length !== 1 ? 's' : ''})`));
          console.log();
          for (const [name, entries] of drifted) {
            console.log(`  ${bold}${name}${reset}`);
            for (const e of entries) {
              console.log(`    ${dim}${e.path}${reset}  ${e.version ?? '(no version)'}`);
            }
          }
        }
        console.log();
        return;
      }

      // Summary grouped by language
      const byLang = new Map<string, typeof packages>();
      for (const pkg of packages) {
        const lang = pkg.language ?? 'unknown';
        if (!byLang.has(lang)) byLang.set(lang, []);
        byLang.get(lang)!.push(pkg);
      }

      console.log();
      console.log(section(`  Workspace Manifest`));
      console.log(`  ${dim}${packages.length} package${packages.length !== 1 ? 's' : ''} across ${byLang.size} ecosystem${byLang.size !== 1 ? 's' : ''}${reset}`);
      console.log();

      for (const [lang, pkgs] of [...byLang.entries()].sort(([a], [b]) => a.localeCompare(b))) {
        console.log(`  ${label(lang)} (${pkgs.length})`);
        for (const pkg of pkgs) {
          const ver = pkg.version ? ` ${dim}v${pkg.version}${reset}` : '';
          const deps = pkg.externalDeps ? `  ${dim}${pkg.externalDeps.length} deps${reset}` : '';
          const lic = licenseMap.has(pkg.id) ? `  ${dim}${licenseMap.get(pkg.id)}${reset}` : '';
          console.log(`    ${bold}${pkg.name}${reset}${ver}  ${dim}${pkg.path}${reset}${deps}${lic}`);
        }
        console.log();
      }

      console.log(`  ${dim}Pass --package <name> for full dep list, --drift for version conflicts.${reset}`);
      console.log();
    });
}
