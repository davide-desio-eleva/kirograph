/**
 * Symbols and relations for infrastructure code: Terraform (HCL), YAML (Helm charts, Kubernetes
 * manifests, GitHub Actions, docker-compose), shell scripts and JSON configuration files.
 *
 * The generic extractor maps tree-sitter node types to symbol kinds, which gives nothing useful
 * for these languages: every Terraform block was a "namespace" named `resource` or `variable`,
 * YAML gave no symbol at all, and a shell script gave its functions but no calls between them.
 *
 * Names follow the language's own addressing, so a search finds what one would type:
 * `aws_s3_bucket.logs`, `var.region`, `module.vpc`, `values.image.tag`, `Deployment/web`.
 *
 * References are resolved by exact qualified name only (refKind `reference` and `qualified_call`,
 * see resolution/index.ts). Infrastructure names repeat across modules and repositories (every
 * module has its `var.region`), and the fuzzy name matching used for code would link them across
 * modules. Qualified names are scoped the way the language scopes them: a Terraform module is a
 * directory, a Helm chart is the directory of its Chart.yaml.
 */

import * as path from 'path';
import type { Node, Edge, NodeKind, Language } from '../types';
import type { UnresolvedRef } from './extractor';
import { makeNodeId } from './extractor';

export interface InfraResult {
  nodes: Node[];
  edges: Edge[];
  unresolvedRefs: UnresolvedRef[];
}

/** At most this many symbols from one YAML or JSON file: a large data file is not configuration. */
const MAX_KEYS_PER_FILE = 500;

function posixDir(relPath: string): string {
  const dir = path.posix.dirname(relPath);
  return dir === '' ? '.' : dir;
}

class Builder {
  readonly nodes: Node[] = [];
  readonly edges: Edge[] = [];
  readonly unresolvedRefs: UnresolvedRef[] = [];
  private readonly seenRefs = new Set<string>();

  constructor(
    private readonly filePath: string,
    private readonly language: Language,
    private readonly now: number,
  ) {}

  node(kind: NodeKind, name: string, qualifiedName: string, start: { row: number; column?: number },
       end: { row: number; column?: number }, extra?: Partial<Node>): Node {
    const startLine = start.row + 1;
    const node: Node = {
      id: makeNodeId(this.filePath, kind, name, startLine),
      kind, name, qualifiedName,
      filePath: this.filePath,
      language: this.language,
      startLine,
      endLine: end.row + 1,
      startColumn: start.column ?? 0,
      endColumn: end.column ?? 0,
      updatedAt: this.now,
      ...extra,
    };
    this.nodes.push(node);
    return node;
  }

  contains(parent: Node, child: Node): void {
    this.edges.push({ source: parent.id, target: child.id, kind: 'contains' });
  }

  /** A reference to the symbol with this exact qualified name (an edge `references` once resolved). */
  ref(source: Node, qualifiedName: string, line: number, column = 0, kind: 'reference' | 'qualified_call' = 'reference'): void {
    if (qualifiedName === source.qualifiedName) return;
    const key = `${source.id}\0${qualifiedName}\0${kind}`;
    if (this.seenRefs.has(key)) return;
    this.seenRefs.add(key);
    this.unresolvedRefs.push({ sourceId: source.id, refName: qualifiedName, refKind: kind as UnresolvedRef['refKind'], line, column });
  }

  result(): InfraResult {
    return { nodes: this.nodes, edges: this.edges, unresolvedRefs: this.unresolvedRefs };
  }
}

const text = (node: any, source: string): string => source.slice(node.startIndex, node.endIndex);

function children(node: any): any[] {
  const out: any[] = [];
  for (let i = 0; i < node.childCount; i++) out.push(node.child(i));
  return out;
}

// ── Terraform (HCL) ──────────────────────────────────────────────────────────

/** Roots of a traversal that are not a resource type. */
const HCL_NON_RESOURCE = new Set(['var', 'local', 'module', 'data', 'each', 'count', 'path', 'self', 'terraform']);
const RESOURCE_TYPE = /^[a-z][a-z0-9]*_[a-z0-9_]+$/;
/** Arguments of a module block that are not inputs of the module. */
const MODULE_META_ARGS = new Set(['source', 'version', 'providers', 'count', 'for_each', 'depends_on']);

function hclLabel(node: any, source: string): string {
  return text(node, source).replace(/^"|"$/g, '');
}

/** A string attribute's literal value, or null when it is not a plain string. */
function hclStringValue(attr: any, source: string): string | null {
  const raw = text(attr, source);
  const m = raw.match(/=\s*"([^"$]*)"\s*$/s);
  return m ? m[1] : null;
}

function hclAttributes(block: any): any[] {
  const body = children(block).find(c => c.type === 'body');
  return body ? children(body).filter(c => c.type === 'attribute') : [];
}

function hclBlocks(block: any): any[] {
  const body = children(block).find(c => c.type === 'body');
  return body ? children(body).filter(c => c.type === 'block') : [];
}

/** The module directory a local `source` points to, relative to the project, or null. */
function localModuleDir(fromDir: string, sourceValue: string): string | null {
  if (!sourceValue.startsWith('./') && !sourceValue.startsWith('../')) return null; // registry, git, …
  const joined = path.posix.normalize(path.posix.join(fromDir === '.' ? '' : fromDir, sourceValue));
  if (joined.startsWith('..')) return null;
  return joined.replace(/\/$/, '') || '.';
}

/** References made by the expressions under `node`: var.x, local.x, module.x, data.t.n, t.n. */
function hclTraversals(node: any, source: string, onRef: (address: string, at: any) => void): void {
  const visit = (n: any) => {
    if (n.type === 'variable_expr') {
      const parts = [text(n, source)];
      let sib = n.nextSibling;
      while (sib && sib.type === 'get_attr' && parts.length < 3) {
        const ident = children(sib).find(c => c.type === 'identifier');
        if (!ident) break;
        parts.push(text(ident, source));
        sib = sib.nextSibling;
      }
      const [root, a, b] = parts;
      if ((root === 'var' || root === 'local' || root === 'module') && a) onRef(`${root}.${a}`, n);
      else if (root === 'data' && a && b) onRef(`data.${a}.${b}`, n);
      else if (a && !HCL_NON_RESOURCE.has(root) && RESOURCE_TYPE.test(root)) onRef(`${root}.${a}`, n);
    }
    for (let i = 0; i < n.childCount; i++) visit(n.child(i));
  };
  visit(node);
}

export function extractHcl(root: any, source: string, relPath: string, now: number): InfraResult {
  const b = new Builder(relPath, 'hcl', now);
  const dir = posixDir(relPath);
  const q = (address: string) => `${dir}::${address}`;
  const body = children(root).find(c => c.type === 'body');
  if (!body) return b.result();

  // A .tfvars file sets the variables of its module
  if (relPath.endsWith('.tfvars')) {
    for (const attr of children(body).filter(c => c.type === 'attribute')) {
      const ident = children(attr).find(c => c.type === 'identifier');
      if (!ident) continue;
      const key = text(ident, source);
      const node = b.node('constant', key, `${relPath}::${key}`, attr.startPosition, attr.endPosition);
      b.ref(node, q(`var.${key}`), attr.startPosition.row + 1);
    }
    return b.result();
  }

  const refsOf = (from: Node, n: any) =>
    hclTraversals(n, source, (address, at) => b.ref(from, q(address), at.startPosition.row + 1, at.startPosition.column));

  for (const block of children(body).filter(c => c.type === 'block')) {
    const parts = children(block);
    const type = text(parts[0], source);
    const labels = parts.filter(c => c.type === 'string_lit' || c.type === 'identifier').slice(1).map(c => hclLabel(c, source));
    const start = block.startPosition;
    const end = block.endPosition;
    const signature = text(block, source).split('\n')[0].replace(/\{\s*$/, '').trim();

    switch (type) {
      case 'resource':
      case 'data': {
        if (labels.length < 2) break;
        const address = type === 'data' ? `data.${labels[0]}.${labels[1]}` : `${labels[0]}.${labels[1]}`;
        const node = b.node('class', address, q(address), start, end, { signature });
        refsOf(node, block);
        // A remote state reads the state another configuration writes (see the backend below)
        if (type === 'data' && labels[0] === 'terraform_remote_state') {
          const key = text(block, source).match(/\bkey\s*=\s*"([^"$]+)"/)?.[1];
          if (key) b.ref(node, `terraform-state::${key}`, start.row + 1);
        }
        break;
      }
      case 'module': {
        if (labels.length < 1) break;
        const node = b.node('module', `module.${labels[0]}`, q(`module.${labels[0]}`), start, end, { signature });
        refsOf(node, block);
        const sourceAttr = hclAttributes(block).find(a => text(children(a)[0], source) === 'source');
        const sourceValue = sourceAttr ? hclStringValue(sourceAttr, source) : null;
        const target = sourceValue ? localModuleDir(dir, sourceValue) : null;
        if (sourceValue) node.signature = `module "${labels[0]}" (source = "${sourceValue}")`;
        if (target) {
          // Each input sets a variable of the called module
          for (const attr of hclAttributes(block)) {
            const name = text(children(attr)[0], source);
            if (!MODULE_META_ARGS.has(name)) b.ref(node, `${target}::var.${name}`, attr.startPosition.row + 1);
          }
        }
        break;
      }
      case 'variable':
      case 'output': {
        if (labels.length < 1) break;
        const address = type === 'variable' ? `var.${labels[0]}` : `output.${labels[0]}`;
        const node = b.node(type === 'variable' ? 'variable' : 'export', address, q(address), start, end, { signature });
        refsOf(node, block);
        break;
      }
      case 'locals': {
        for (const attr of hclAttributes(block)) {
          const name = text(children(attr)[0], source);
          const node = b.node('constant', `local.${name}`, q(`local.${name}`), attr.startPosition, attr.endPosition);
          refsOf(node, attr);
        }
        break;
      }
      case 'provider': {
        if (labels.length < 1) break;
        const node = b.node('namespace', `provider.${labels[0]}`, q(`provider.${labels[0]}`), start, end, { signature });
        refsOf(node, block);
        break;
      }
      case 'terraform': {
        // The state this configuration writes: what a terraform_remote_state elsewhere reads
        for (const inner of hclBlocks(block)) {
          if (text(children(inner)[0], source) !== 'backend') continue;
          const key = text(inner, source).match(/\bkey\s*=\s*"([^"$]+)"/)?.[1];
          if (key) {
            b.node('namespace', `state:${key}`, `terraform-state::${key}`, inner.startPosition, inner.endPosition,
              { signature: text(inner, source).split('\n')[0].replace(/\{\s*$/, '').trim() });
          }
        }
        break;
      }
      default: {
        // moved, import, check and other blocks: named by their type and labels
        const name = [type, ...labels].join('.');
        const node = b.node('namespace', name, q(name), start, end, { signature });
        refsOf(node, block);
      }
    }
  }
  return b.result();
}

// ── YAML ─────────────────────────────────────────────────────────────────────

interface YamlEntry { key: string; keyNode: any; valueNode: any | null; pair: any }

/** The scalar text of a flow node, without quotes, or null for anything else. */
function yamlScalar(node: any | null, source: string): string | null {
  if (!node) return null;
  let n = node;
  while (n && (n.type === 'flow_node' || n.type === 'block_node') && n.childCount > 0) {
    const inner = children(n).find(c => c.type !== 'anchor' && c.type !== 'tag');
    if (!inner) break;
    n = inner;
  }
  if (!n) return null;
  if (n.type === 'plain_scalar' || n.type === 'string_scalar') return text(n, source).trim();
  if (n.type === 'double_quote_scalar' || n.type === 'single_quote_scalar') return text(n, source).slice(1, -1);
  return null;
}

/** The mapping under a node (through block_node and flow_node), or null. */
function yamlMapping(node: any | null): any | null {
  let n = node;
  while (n && (n.type === 'block_node' || n.type === 'flow_node' || n.type === 'document')) {
    n = children(n).find(c => c.type === 'block_node' || c.type === 'flow_node'
      || c.type === 'block_mapping' || c.type === 'flow_mapping') ?? null;
  }
  return n && (n.type === 'block_mapping' || n.type === 'flow_mapping') ? n : null;
}

function yamlSequence(node: any | null): any[] {
  let n = node;
  while (n && (n.type === 'block_node' || n.type === 'flow_node')) {
    n = children(n).find(c => c.type === 'block_sequence' || c.type === 'flow_sequence' || c.type === 'block_node' || c.type === 'flow_node') ?? null;
  }
  if (!n) return [];
  if (n.type === 'block_sequence') {
    return children(n).filter(c => c.type === 'block_sequence_item').map(i => children(i).find(c => c.type === 'flow_node' || c.type === 'block_node')).filter(Boolean);
  }
  if (n.type === 'flow_sequence') return children(n).filter(c => c.type === 'flow_node');
  return [];
}

function yamlEntries(mapping: any | null, source: string): YamlEntry[] {
  if (!mapping) return [];
  const out: YamlEntry[] = [];
  for (const pair of children(mapping)) {
    if (pair.type !== 'block_mapping_pair' && pair.type !== 'flow_pair') continue;
    const keyNode = pair.childForFieldName?.('key') ?? children(pair)[0];
    const valueNode = pair.childForFieldName?.('value') ?? children(pair).slice(1).find(c => c.type !== ':') ?? null;
    const key = yamlScalar(keyNode, source);
    if (key !== null) out.push({ key, keyNode, valueNode, pair });
  }
  return out;
}

function get(entries: YamlEntry[], key: string): YamlEntry | undefined {
  return entries.find(e => e.key === key);
}

/** The directory of the Helm chart a file belongs to, from the conventional layout, or null. */
function helmChartDir(relPath: string): string | null {
  const base = path.posix.basename(relPath);
  if (base === 'values.yaml' || base === 'values.yml' || base === 'Chart.yaml') return posixDir(relPath);
  const i = relPath.lastIndexOf('/templates/');
  if (i >= 0) return relPath.slice(0, i) || '.';
  if (relPath.startsWith('templates/')) return '.';
  return null;
}

/** A Helm template (or any file with Go template syntax): its .Values uses, includes and defines. */
export function extractHelmTemplate(source: string, relPath: string, now: number): InfraResult {
  const b = new Builder(relPath, 'yaml', now);
  const chart = helmChartDir(relPath) ?? posixDir(relPath);
  const lines = source.split('\n');
  const file = b.node('module', path.posix.basename(relPath), `${relPath}::template`, { row: 0 }, { row: Math.max(0, lines.length - 1) });

  const lineOf = (index: number) => source.slice(0, index).split('\n').length;
  for (const m of source.matchAll(/\{\{-?\s*define\s+"([^"]+)"/g)) {
    const line = lineOf(m.index ?? 0);
    const def = b.node('function', m[1], `${chart}::define.${m[1]}`, { row: line - 1 }, { row: line - 1 });
    b.contains(file, def);
  }
  for (const m of source.matchAll(/\b(?:include|template)\s+"([^"]+)"/g)) {
    b.ref(file, `${chart}::define.${m[1]}`, lineOf(m.index ?? 0), 0, 'qualified_call');
  }
  for (const m of source.matchAll(/\.Values((?:\.[A-Za-z0-9_-]+)+)/g)) {
    const keys = m[1].slice(1).split('.').slice(0, 4); // values symbols go four levels deep
    b.ref(file, `${chart}::values.${keys.join('.')}`, lineOf(m.index ?? 0));
  }
  return b.result();
}

export function extractYaml(root: any, source: string, relPath: string, now: number): InfraResult {
  const b = new Builder(relPath, 'yaml', now);
  const base = path.posix.basename(relPath);
  const documents = children(root).filter(c => c.type === 'document');
  let budget = MAX_KEYS_PER_FILE;
  const take = () => budget-- > 0;

  const chart = helmChartDir(relPath);
  const isValues = chart !== null && (base === 'values.yaml' || base === 'values.yml');
  const isWorkflow = /(^|\/)\.github\/workflows\/[^/]+\.ya?ml$/.test(relPath);
  const isAction = /(^|\/)action\.ya?ml$/.test(relPath);
  const isCompose = /^(docker-)?compose(\.[\w-]+)?\.ya?ml$/.test(base);

  for (const doc of documents) {
    const top = yamlEntries(yamlMapping(doc), source);
    if (top.length === 0) continue;

    if (isValues) {
      // Helm values: every key, four levels deep, addressed as templates use them
      const walk = (entries: YamlEntry[], prefix: string[], parent: Node | null) => {
        for (const e of entries) {
          if (!take()) return;
          const keys = [...prefix, e.key];
          const name = `values.${keys.join('.')}`;
          const node = b.node('property', name, `${chart}::${name}`, e.pair.startPosition, e.pair.endPosition,
            { signature: text(e.pair, source).split('\n')[0].trim() });
          if (parent) b.contains(parent, node);
          if (keys.length < 4) walk(yamlEntries(yamlMapping(e.valueNode), source), keys, node);
        }
      };
      walk(top, [], null);
      continue;
    }

    if (base === 'Chart.yaml' && chart !== null) {
      const name = yamlScalar(get(top, 'name')?.valueNode ?? null, source) ?? chart;
      const node = b.node('module', `chart.${name}`, `${chart}::chart`, doc.startPosition, doc.endPosition);
      for (const dep of yamlSequence(get(top, 'dependencies')?.valueNode ?? null)) {
        const entries = yamlEntries(yamlMapping(dep), source);
        const depName = yamlScalar(get(entries, 'name')?.valueNode ?? null, source);
        if (!depName || !take()) continue;
        const repo = yamlScalar(get(entries, 'repository')?.valueNode ?? null, source);
        const imp = b.node('import', depName, `${chart}::dependency.${depName}`, dep.startPosition, dep.endPosition,
          { signature: repo ? `${depName} (${repo})` : depName });
        b.contains(node, imp);
        if (repo?.startsWith('file://')) {
          const target = path.posix.normalize(path.posix.join(chart === '.' ? '' : chart, repo.slice('file://'.length)));
          b.ref(imp, `${target}::chart`, dep.startPosition.row + 1);
        }
      }
      continue;
    }

    if (isWorkflow || isAction) {
      const jobsEntry = get(top, isAction ? 'runs' : 'jobs');
      const workflowName = yamlScalar(get(top, 'name')?.valueNode ?? null, source) ?? base;
      const wf = b.node('module', workflowName, `${relPath}::workflow`, doc.startPosition, doc.endPosition);
      const jobs = isAction ? (jobsEntry ? [{ ...jobsEntry, key: 'runs' }] : []) : yamlEntries(yamlMapping(jobsEntry?.valueNode ?? null), source);
      for (const job of jobs) {
        if (!take()) break;
        const jobNode = b.node('function', job.key, `${relPath}::jobs.${job.key}`, job.pair.startPosition, job.pair.endPosition);
        b.contains(wf, jobNode);
        const fields = yamlEntries(yamlMapping(job.valueNode), source);
        const needs = get(fields, 'needs');
        if (needs) {
          const one = yamlScalar(needs.valueNode, source);
          const all = one !== null ? [one] : yamlSequence(needs.valueNode).map(n => yamlScalar(n, source)).filter((s): s is string => !!s);
          for (const need of all) b.ref(jobNode, `${relPath}::jobs.${need}`, needs.pair.startPosition.row + 1, 0, 'qualified_call');
        }
        // A reusable workflow called by the job, and the actions its steps use
        const uses: Array<{ value: string; at: any }> = [];
        const jobUses = get(fields, 'uses');
        const jobUsesValue = yamlScalar(jobUses?.valueNode ?? null, source);
        if (jobUses && jobUsesValue) uses.push({ value: jobUsesValue, at: jobUses.pair });
        for (const step of yamlSequence(get(fields, 'steps')?.valueNode ?? null)) {
          const stepUses = get(yamlEntries(yamlMapping(step), source), 'uses');
          const value = yamlScalar(stepUses?.valueNode ?? null, source);
          if (stepUses && value) uses.push({ value, at: stepUses.pair });
        }
        for (const u of uses) {
          if (!take()) break;
          const imp = b.node('import', u.value, `${relPath}::uses.${u.value}`, u.at.startPosition, u.at.endPosition);
          b.contains(jobNode, imp);
          if (u.value.startsWith('./')) {
            const target = u.value.slice(2).replace(/\/$/, '');
            // A local reusable workflow is a file; a local action is a folder with action.yml
            if (/\.ya?ml$/.test(target)) b.ref(imp, `${target}::workflow`, u.at.startPosition.row + 1);
            else {
              b.ref(imp, `${target}/action.yml::workflow`, u.at.startPosition.row + 1);
              b.ref(imp, `${target}/action.yaml::workflow`, u.at.startPosition.row + 1);
            }
          }
        }
      }
      continue;
    }

    if (isCompose) {
      for (const svc of yamlEntries(yamlMapping(get(top, 'services')?.valueNode ?? null), source)) {
        if (!take()) break;
        const fields = yamlEntries(yamlMapping(svc.valueNode), source);
        const image = yamlScalar(get(fields, 'image')?.valueNode ?? null, source);
        const node = b.node('class', svc.key, `${relPath}::services.${svc.key}`, svc.pair.startPosition, svc.pair.endPosition,
          image ? { signature: `${svc.key} (${image})` } : undefined);
        const dependsOn = get(fields, 'depends_on');
        if (dependsOn) {
          const listed = yamlSequence(dependsOn.valueNode).map(n => yamlScalar(n, source)).filter((s): s is string => !!s);
          const keyed = yamlEntries(yamlMapping(dependsOn.valueNode), source).map(e => e.key);
          for (const dep of [...listed, ...keyed]) b.ref(node, `${relPath}::services.${dep}`, dependsOn.pair.startPosition.row + 1);
        }
      }
      continue;
    }

    // A Kubernetes manifest: one symbol per object, named kind/name
    const kind = yamlScalar(get(top, 'kind')?.valueNode ?? null, source);
    const metadata = yamlEntries(yamlMapping(get(top, 'metadata')?.valueNode ?? null), source);
    const objectName = yamlScalar(get(metadata, 'name')?.valueNode ?? null, source);
    if (kind && objectName && get(top, 'apiVersion')) {
      if (!take()) break;
      const namespace = yamlScalar(get(metadata, 'namespace')?.valueNode ?? null, source);
      b.node('class', `${kind}/${objectName}`, `${relPath}::${kind}/${objectName}`, doc.startPosition, doc.endPosition,
        { signature: namespace ? `${kind}/${objectName} (namespace ${namespace})` : `${kind}/${objectName}` });
      continue;
    }

    // Any other YAML: its top-level keys
    for (const e of top) {
      if (!take()) break;
      b.node('property', e.key, `${relPath}::${e.key}`, e.pair.startPosition, e.pair.endPosition,
        { signature: text(e.pair, source).split('\n')[0].trim() });
    }
  }
  return b.result();
}

// ── Shell ────────────────────────────────────────────────────────────────────

/**
 * Adds to the generic extraction of a shell script: the files it sources (imports), and calls
 * to functions, defined in the same file (resolved here) or in a sourced one (resolved by
 * qualified name, so a command never links to an unrelated function of the same name elsewhere).
 */
/** Builtins and common commands: a call to one of these is never to a function of the project. */
const SHELL_COMMANDS = new Set([
  'alias', 'awk', 'basename', 'bash', 'break', 'cat', 'cd', 'chmod', 'chown', 'command', 'continue', 'cp', 'curl',
  'cut', 'date', 'declare', 'dirname', 'docker', 'echo', 'env', 'eval', 'exec', 'exit', 'export', 'false', 'find',
  'getopts', 'git', 'grep', 'head', 'jq', 'kill', 'kubectl', 'let', 'ln', 'local', 'ls', 'mkdir', 'mktemp', 'mv',
  'popd', 'printf', 'pushd', 'pwd', 'read', 'readonly', 'realpath', 'return', 'rm', 'sed', 'set', 'shift', 'sleep',
  'sort', 'source', 'sudo', 'tail', 'tee', 'terraform', 'helm', 'test', 'tr', 'trap', 'true', 'type', 'uniq',
  'unset', 'wait', 'wc', 'xargs', 'aws', 'python', 'python3', 'node', 'npm', 'make', 'ssh', 'scp', 'tar', 'unzip',
]);

export function augmentBash(root: any, source: string, relPath: string, now: number, result: InfraResult): void {
  const b = new Builder(relPath, 'bash', now);
  const functions = new Map<string, Node>();
  for (const n of result.nodes) if (n.kind === 'function') functions.set(n.name, n);
  // The script itself: what code outside any function belongs to, and what sourcing it points at
  const script = b.node('module', path.posix.basename(relPath), `${relPath}::script`, { row: 0 }, root.endPosition);

  const enclosing = (n: any): Node => {
    for (let p = n.parent; p; p = p.parent) {
      if (p.type === 'function_definition') {
        const name = children(p).find(c => c.type === 'word');
        const fn = name ? functions.get(text(name, source)) : undefined;
        if (fn && fn.startLine === p.startPosition.row + 1) return fn;
      }
    }
    return script;
  };

  const dir = posixDir(relPath) === '.' ? '' : posixDir(relPath);
  const sourced: string[] = [];
  const calls: Array<{ name: string; at: any }> = [];
  const visit = (n: any) => {
    if (n.type === 'command') {
      const nameNode = children(n).find(c => c.type === 'command_name');
      const name = nameNode ? text(nameNode, source).trim() : '';
      if (name === 'source' || name === '.') {
        // (tree-sitter returns a new object for each child access: compare types, not identity)
        const arg = children(n).find(c => c.type !== 'command_name' && c.type !== 'comment');
        const raw = arg ? text(arg, source).replace(/^["']|["']$/g, '') : '';
        // A literal path, or one built from the script's own folder: "$DIR/lib.sh", "$(dirname "$0")/lib.sh"
        const tail = raw.includes('$') ? raw.match(/\/([^$"'`()]+)$/)?.[1] : raw;
        if (tail && /^[\w./-]+$/.test(tail)) {
          const rel = path.posix.normalize(path.posix.join(dir, tail));
          if (!rel.startsWith('..')) {
            const imp = b.node('import', tail, `${relPath}::source.${rel}`, n.startPosition, n.endPosition);
            b.contains(enclosing(n), imp);
            b.ref(imp, `${rel}::script`, n.startPosition.row + 1);
            sourced.push(rel);
          }
        }
      } else if (/^[A-Za-z_][\w:-]*$/.test(name) && !SHELL_COMMANDS.has(name)) {
        calls.push({ name, at: n });
      }
    }
    for (let i = 0; i < n.childCount; i++) visit(n.child(i));
  };
  visit(root);

  const seen = new Set<string>();
  for (const { name, at } of calls) {
    const from = enclosing(at);
    const key = `${from.id}\0${name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const local = functions.get(name);
    if (local) {
      if (local.id !== from.id) b.edges.push({ source: from.id, target: local.id, kind: 'calls', line: at.startPosition.row + 1 });
    } else {
      // Defined in a sourced file, if anywhere: one exact candidate per sourced file
      for (const rel of sourced) b.ref(from, `${rel}::${name}`, at.startPosition.row + 1, at.startPosition.column, 'qualified_call');
    }
  }
  for (const fn of functions.values()) b.contains(script, fn);

  result.nodes.push(...b.nodes);
  result.edges.push(...b.edges);
  result.unresolvedRefs.push(...b.unresolvedRefs);
}

// ── JSON configuration ───────────────────────────────────────────────────────

interface JsonKey { path: string[]; line: number; endLine: number; value: string | null; isObject: boolean }

/**
 * The keys of a JSON document (JSON with comments and trailing commas, as tsconfig allows), with
 * their lines, `depth` levels deep, skipping keys inside arrays. A string value is kept.
 */
function scanJson(source: string, depth: number): JsonKey[] | null {
  const keys: JsonKey[] = [];
  let i = 0;
  let line = 1;
  const n = source.length;
  const ws = () => {
    for (;;) {
      const c = source[i];
      if (c === '\n') { line++; i++; }
      else if (c === ' ' || c === '\t' || c === '\r' || c === '﻿') i++;
      else if (c === '/' && source[i + 1] === '/') { while (i < n && source[i] !== '\n') i++; }
      else if (c === '/' && source[i + 1] === '*') {
        i += 2;
        while (i < n && !(source[i] === '*' && source[i + 1] === '/')) { if (source[i] === '\n') line++; i++; }
        i += 2;
      } else return;
    }
  };
  const str = (): string => {
    let out = '';
    i++; // opening quote
    while (i < n && source[i] !== '"') {
      if (source[i] === '\\') { out += source[i + 1] ?? ''; i += 2; continue; }
      if (source[i] === '\n') line++;
      out += source[i++];
    }
    i++;
    return out;
  };
  const value = (pathTo: string[], inArray: boolean): string | null => {
    ws();
    const c = source[i];
    if (c === '{') { object(pathTo, inArray); return null; }
    if (c === '[') {
      i++;
      for (;;) {
        ws();
        if (source[i] === ']') { i++; return null; }
        if (i >= n) throw new Error('unterminated array');
        value(pathTo, true);
        ws();
        if (source[i] === ',') i++;
      }
    }
    if (c === '"') return str();
    while (i < n && !/[,}\]\s]/.test(source[i])) i++;
    return null;
  };
  const object = (pathTo: string[], inArray: boolean) => {
    i++; // {
    for (;;) {
      ws();
      if (source[i] === '}') { i++; return; }
      if (i >= n || source[i] !== '"') throw new Error('expected a key');
      const keyLine = line;
      const key = str();
      ws();
      if (source[i] !== ':') throw new Error('expected :');
      i++;
      ws();
      const isObject = source[i] === '{';
      const childPath = [...pathTo, key];
      const record = !inArray && childPath.length <= depth;
      const entry: JsonKey | null = record ? { path: childPath, line: keyLine, endLine: keyLine, value: null, isObject } : null;
      if (entry) keys.push(entry);
      const v = value(childPath, inArray);
      if (entry) { entry.value = v; entry.endLine = line; }
      ws();
      if (source[i] === ',') i++;
    }
  };
  try {
    ws();
    if (source[i] !== '{') return [];
    object([], false);
    return keys;
  } catch {
    return null;
  }
}

/** Matches `npm run x`, `yarn x`, `pnpm x`, `bun run x` in a package.json script. */
const RUN_SCRIPT = /\b(?:npm|pnpm|bun)\s+(?:run(?:-script)?\s+)?([\w:.-]+)|\byarn\s+(?:run\s+)?([\w:.-]+)/g;

export function extractJsonConfig(source: string, relPath: string, now: number): InfraResult {
  const b = new Builder(relPath, 'json', now);
  const keys = scanJson(source, 3);
  if (!keys) return b.result();
  const isPackage = path.posix.basename(relPath) === 'package.json';
  const byPath = new Map<string, Node>();
  for (const k of keys.slice(0, MAX_KEYS_PER_FILE)) {
    const name = k.path.join('.');
    const isScript = isPackage && k.path.length === 2 && k.path[0] === 'scripts';
    const node = b.node(isScript ? 'function' : 'property', name, `${relPath}::${name}`,
      { row: k.line - 1 }, { row: k.endLine - 1 },
      { signature: k.value !== null ? `${k.path[k.path.length - 1]}: ${JSON.stringify(k.value).slice(0, 200)}` : undefined });
    const parent = byPath.get(k.path.slice(0, -1).join('.'));
    if (parent) b.contains(parent, node);
    if (k.isObject) byPath.set(name, node);
    if (isScript && k.value) {
      for (const m of k.value.matchAll(RUN_SCRIPT)) {
        const target = m[1] ?? m[2];
        if (target && !['install', 'i', 'ci', 'add', 'exec', 'dlx', 'x'].includes(target)) {
          b.ref(node, `${relPath}::scripts.${target}`, k.line, 0, 'qualified_call');
        }
      }
    }
  }
  return b.result();
}
