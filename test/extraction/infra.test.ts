import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { extractFile } from '../../src/extraction/extractor';
import { detectLanguage } from '../../src/extraction/languages';
import KiroGraph from '../../src/index';

const ROOT = '/proj';
const extract = (relPath: string, content: string) => extractFile(`${ROOT}/${relPath}`, ROOT, content);
const names = (r: any, kind?: string) => r.nodes.filter((n: any) => !kind || n.kind === kind).map((n: any) => n.name).sort();
const refs = (r: any) => r.unresolvedRefs.map((u: any) => `${u.refKind}:${u.refName}`).sort();

describe('Terraform', () => {
  const main = [
    'variable "region" { type = string }',
    'locals { name = "logs-${var.region}" }',
    'resource "aws_s3_bucket" "logs" {',
    '  bucket = local.name',
    '  tags   = { vpc = module.vpc.vpc_id }',
    '}',
    'module "vpc" {',
    '  source = "../modules/vpc"',
    '  cidr   = "10.0.0.0/16"',
    '  count  = 1',
    '}',
    'data "terraform_remote_state" "net" {',
    '  backend = "s3"',
    '  config  = { bucket = "states", key = "network/terraform.tfstate" }',
    '}',
    'output "arn" { value = aws_s3_bucket.logs.arn }',
    'terraform {',
    '  backend "s3" { key = "app/terraform.tfstate" }',
    '}',
  ].join('\n');

  it('names blocks by their address', async () => {
    const r = await extract('live/app/main.tf', main);
    expect(names(r)).toEqual([
      'aws_s3_bucket.logs', 'data.terraform_remote_state.net', 'local.name', 'module.vpc',
      'output.arn', 'state:app/terraform.tfstate', 'var.region',
    ]);
    expect(r!.nodes.find(n => n.name === 'module.vpc')!.signature).toBe('module "vpc" (source = "../modules/vpc")');
    expect(r!.nodes.find(n => n.name === 'var.region')!.qualifiedName).toBe('live/app::var.region');
  });

  it('references what expressions use, the inputs of a local module, and remote states', async () => {
    const r = await extract('live/app/main.tf', main);
    expect(refs(r)).toEqual([
      'reference:live/app::aws_s3_bucket.logs',
      'reference:live/app::local.name',
      'reference:live/app::module.vpc',
      'reference:live/app::var.region',
      'reference:live/modules/vpc::var.cidr', // count is a meta-argument, not an input
      'reference:terraform-state::network/terraform.tfstate',
    ]);
  });

  it('reads a .tfvars file as values for the variables of its module', async () => {
    const r = await extract('live/app/prod.tfvars', 'region = "eu-west-1"\n');
    expect(names(r)).toEqual(['region']);
    expect(refs(r)).toEqual(['reference:live/app::var.region']);
  });
});

describe('YAML', () => {
  it('Helm values are addressed as templates use them, and templates reference them', async () => {
    const values = await extract('charts/web/values.yaml', 'image:\n  repository: nginx\n  tag: "1.25"\nreplicas: 2\n');
    expect(names(values)).toEqual(['values.image', 'values.image.repository', 'values.image.tag', 'values.replicas']);
    expect(values!.nodes[0].qualifiedName).toBe('charts/web::values.image');

    const template = await extract('charts/web/templates/deployment.yaml', [
      'apiVersion: apps/v1',
      'kind: Deployment',
      'metadata:',
      '  name: {{ include "web.fullname" . }}',
      'spec:',
      '  replicas: {{ .Values.replicas }}',
      '  template:',
      '    spec:',
      '      containers:',
      '        - image: "{{ .Values.image.repository }}:{{ .Values.image.tag }}"',
    ].join('\n'));
    expect(refs(template)).toEqual([
      'qualified_call:charts/web::define.web.fullname',
      'reference:charts/web::values.image.repository',
      'reference:charts/web::values.image.tag',
      'reference:charts/web::values.replicas',
    ]);

    const helpers = await extract('charts/web/templates/_helpers.tpl', '{{- define "web.fullname" -}}\nweb\n{{- end }}\n');
    expect(helpers!.nodes.find(n => n.kind === 'function')!.qualifiedName).toBe('charts/web::define.web.fullname');
  });

  it('a Kubernetes manifest gives one symbol per object', async () => {
    const r = await extract('k8s/app.yaml', [
      'apiVersion: v1', 'kind: Service', 'metadata:', '  name: web', '  namespace: prod', '---',
      'apiVersion: apps/v1', 'kind: Deployment', 'metadata:', '  name: web',
    ].join('\n'));
    expect(names(r)).toEqual(['Deployment/web', 'Service/web']);
  });

  it('a workflow gives its jobs, what they need and the actions they use', async () => {
    const r = await extract('.github/workflows/ci.yml', [
      'name: CI', 'on: push', 'jobs:',
      '  build:', '    runs-on: ubuntu-latest', '    steps:',
      '      - uses: actions/checkout@v4', '      - run: make',
      '  deploy:', '    needs: [build]', '    uses: ./.github/workflows/deploy.yml',
    ].join('\n'));
    expect(names(r, 'function')).toEqual(['build', 'deploy']);
    expect(names(r, 'import')).toEqual(['./.github/workflows/deploy.yml', 'actions/checkout@v4']);
    expect(refs(r)).toEqual([
      'qualified_call:.github/workflows/ci.yml::jobs.build',
      'reference:.github/workflows/deploy.yml::workflow',
    ]);
  });

  it('docker compose gives its services and their dependencies', async () => {
    const r = await extract('compose.yaml', 'services:\n  db:\n    image: postgres:16\n  api:\n    build: .\n    depends_on:\n      - db\n');
    expect(names(r)).toEqual(['api', 'db']);
    expect(refs(r)).toEqual(['reference:compose.yaml::services.db']);
  });

  it('any other YAML gives its top-level keys', async () => {
    const r = await extract('config/app.yaml', 'name: demo\nitems:\n  - a\n');
    expect(names(r)).toEqual(['items', 'name']);
  });
});

describe('shell', () => {
  it('links calls to functions and the files a script sources', async () => {
    const r = await extract('scripts/deploy.sh', [
      '#!/usr/bin/env bash',
      'source ./lib.sh',
      '. "$(dirname "$0")/common.sh"',
      'build() { echo building; }',
      'main() {',
      '  build',
      '  publish "$1"',
      '}',
      'main "$@"',
    ].join('\n'));
    expect(names(r, 'import')).toEqual(['./lib.sh', 'common.sh']);
    const id = (name: string) => r!.nodes.find(n => n.name === name)!.id;
    const calls = r!.edges.filter(e => e.kind === 'calls').map(e => `${e.source === id('main') ? 'main' : 'script'}->${e.target === id('build') ? 'build' : 'main'}`).sort();
    expect(calls).toEqual(['main->build', 'script->main']);
    // publish is defined in neither: it may be in a sourced file, and only there
    expect(refs(r)).toEqual([
      'qualified_call:scripts/common.sh::publish',
      'qualified_call:scripts/lib.sh::publish',
      'reference:scripts/common.sh::script',
      'reference:scripts/lib.sh::script',
    ]);
  });
});

describe('JSON configuration', () => {
  it('is detected by name and folder, not for every JSON file', () => {
    expect(detectLanguage('/p/package.json')).toBe('json');
    expect(detectLanguage('/p/tsconfig.build.json')).toBe('json');
    expect(detectLanguage('/p/config/default.json')).toBe('json');
    expect(detectLanguage('/p/app.config.json')).toBe('json');
    expect(detectLanguage('/p/package-lock.json')).toBe('unknown');
    expect(detectLanguage('/p/fixtures/users.json')).toBe('unknown');
    expect(detectLanguage('/config/p/src/data.json')).toBe('unknown'); // a folder above the file's own
  });

  it('gives keys three levels deep, scripts as functions, and script-to-script calls', async () => {
    const r = await extract('package.json', JSON.stringify({
      name: 'demo',
      scripts: { build: 'tsc', test: 'npm run build && vitest', release: 'yarn test' },
      deps: [{ ignored: true }],
    }, null, 2));
    expect(names(r, 'function')).toEqual(['scripts.build', 'scripts.release', 'scripts.test']);
    expect(names(r, 'property')).toEqual(['deps', 'name', 'scripts']);
    expect(refs(r)).toEqual(['qualified_call:package.json::scripts.build', 'qualified_call:package.json::scripts.test']);
    expect(r!.nodes.find(n => n.name === 'scripts.test')!.startLine).toBe(5);
  });

  it('reads JSON with comments and trailing commas', async () => {
    const r = await extract('tsconfig.json', '// base\n{\n  /* opts */ "compilerOptions": { "strict": true, },\n}\n');
    expect(names(r)).toEqual(['compilerOptions', 'compilerOptions.strict']);
  });
});

describe('resolution', () => {
  let root: string;
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'kg-infra-')); });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (rel: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  };

  it('links across files only within the scope the language gives a name', async () => {
    write('modules/vpc/variables.tf', 'variable "cidr" { type = string }\n');
    write('modules/other/variables.tf', 'variable "cidr" { type = string }\n');
    write('live/main.tf', 'module "vpc" {\n  source = "../modules/vpc"\n  cidr = "10.0.0.0/16"\n}\n');
    write('network/backend.tf', 'terraform {\n  backend "s3" { key = "network/terraform.tfstate" }\n}\n');
    write('live/remote.tf', 'data "terraform_remote_state" "net" {\n  config = { key = "network/terraform.tfstate" }\n}\n');
    write('charts/web/Chart.yaml', 'apiVersion: v2\nname: web\n');
    write('charts/web/values.yaml', 'image:\n  tag: "1"\n');
    write('charts/web/templates/pod.yaml', 'image: {{ .Values.image.tag }}\n');

    const kg = await KiroGraph.init(root);
    try {
      await kg.indexAll();
      const db = (kg as any).db.getRawDb();
      const linked = (db.all(`
        SELECT s.qualified_name AS source, t.qualified_name AS target FROM edges e
          JOIN nodes s ON s.id = e.source JOIN nodes t ON t.id = e.target
         WHERE e.kind = 'references'`) as Array<{ source: string; target: string }>)
        .map(r => `${r.source} -> ${r.target}`).sort();
      expect(linked).toEqual([
        'charts/web/templates/pod.yaml::template -> charts/web::values.image.tag',
        'live::data.terraform_remote_state.net -> terraform-state::network/terraform.tfstate',
        'live::module.vpc -> modules/vpc::var.cidr', // not modules/other
      ]);
      expect(kg.searchNodes('aws_s3_bucket').length).toBe(0);
      expect(kg.searchNodes('var.cidr').length).toBeGreaterThan(0);
    } finally {
      kg.close();
    }
  });
});
