/**
 * Which JSON files are indexed (as language `json`, see infra.ts extractJsonConfig).
 *
 * Kept apart from the extractor so language detection, which runs for every file of every scan,
 * loads nothing else.
 */

/**
 * The JSON files indexed as configuration. JSON is not indexed as a whole (fixtures, data and
 * generated files would bury the configuration), only files whose name or folder says they
 * configure something.
 */
const JSON_CONFIG_NAMES = new Set([
  'package.json', 'composer.json', 'tsconfig.json', 'jsconfig.json', 'angular.json', 'nx.json', 'project.json',
  'lerna.json', 'turbo.json', 'vercel.json', 'firebase.json', 'cdk.json', 'app.json', 'renovate.json',
  '.eslintrc.json', '.prettierrc.json', '.babelrc', '.babelrc.json', '.swcrc', 'deno.json', 'biome.json',
  'devcontainer.json', '.devcontainer.json', 'launch.json', 'settings.json', 'tasks.json', 'extensions.json',
  'appsettings.json', 'local.settings.json', 'host.json', 'serverless.json', 'manifest.json',
]);
const JSON_CONFIG_PATTERNS = [
  /^tsconfig\..+\.json$/, /^jsconfig\..+\.json$/, /^appsettings\..+\.json$/,
  /\.config\.json$/, /\.settings\.json$/, /^\.?[\w-]+rc\.json$/,
];
// The folder a file is directly in. Only that one: callers pass absolute paths, and a folder named
// config above the project must not make every JSON file in it configuration.
const JSON_CONFIG_FOLDERS = /(^|\/)(config|configs|conf|settings|environments|\.vscode|\.devcontainer)\/[^/]+$/;
const NOT_CONFIG = /(^|\/)(package-lock|npm-shrinkwrap|composer\.lock)\.json$|\.min\.json$|\.lock\.json$/;

export function isJsonConfigFile(filePath: string): boolean {
  const p = filePath.replace(/\\/g, '/');
  if (!p.endsWith('.json') && !p.endsWith('.babelrc') && !p.endsWith('.swcrc')) return false;
  if (NOT_CONFIG.test(p)) return false;
  const base = p.slice(p.lastIndexOf('/') + 1);
  return JSON_CONFIG_NAMES.has(base) || JSON_CONFIG_PATTERNS.some(r => r.test(base)) || JSON_CONFIG_FOLDERS.test(p);
}
