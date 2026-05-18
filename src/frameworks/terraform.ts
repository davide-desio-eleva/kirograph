/**
 * Terraform / OpenTofu Framework Resolver
 *
 * Since HCL doesn't have a bundled WASM grammar, this resolver uses regex-based
 * extraction to create nodes from .tf files. It extracts:
 * - Resources as class-like nodes
 * - Data sources as variable-like nodes
 * - Modules as namespace-like nodes
 * - Variables and outputs as variable/export nodes
 * - API Gateway routes as route nodes
 */

import type { Node } from '../types';
import type { FrameworkResolver, UnresolvedRef, ResolvedRef, ResolutionContext } from './types';

export const terraformResolver: FrameworkResolver = {
  name: 'terraform',
  detect(context: ResolutionContext): boolean {
    if (context.fileExists('.terraform') || context.fileExists('.terraform.lock.hcl')) return true;
    return context.getAllFiles().some(f => f.endsWith('.tf'));
  },
  resolve(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
    // Resolve resource references (e.g., aws_lambda_function.my_func)
    if (ref.referenceName.includes('.')) {
      const parts = ref.referenceName.split('.');
      if (parts.length >= 2) {
        const resourceName = parts.slice(0, 2).join('.');
        const id = resolveResource(resourceName, context);
        if (id) return { original: ref, targetNodeId: id, confidence: 0.85, resolvedBy: 'framework' };
      }
    }
    // Resolve module references
    if (ref.referenceName.startsWith('module.')) {
      const moduleName = ref.referenceName.replace('module.', '');
      const id = resolveModule(moduleName, context);
      if (id) return { original: ref, targetNodeId: id, confidence: 0.9, resolvedBy: 'framework' };
    }
    // Resolve variable references
    if (ref.referenceName.startsWith('var.')) {
      const varName = ref.referenceName.replace('var.', '');
      const id = resolveVariable(varName, context);
      if (id) return { original: ref, targetNodeId: id, confidence: 0.9, resolvedBy: 'framework' };
    }
    return null;
  },
  extractNodes(filePath: string, content: string): Node[] {
    if (!filePath.endsWith('.tf') && !filePath.endsWith('.tfvars')) return [];

    const nodes: Node[] = [];
    const now = Date.now();

    // Extract resource blocks: resource "aws_type" "name" {
    const resourcePattern = /^resource\s+"([^"]+)"\s+"([^"]+)"\s*\{/gm;
    let match: RegExpExecArray | null;
    while ((match = resourcePattern.exec(content)) !== null) {
      const line = content.slice(0, match.index).split('\n').length;
      const resourceType = match[1]!;
      const resourceName = match[2]!;
      const name = `${resourceType}.${resourceName}`;
      const endLine = findBlockEnd(content, match.index + match[0].length);
      nodes.push({
        id: `resource:${filePath}:${name}:${line}`,
        kind: 'class',
        name,
        qualifiedName: `${filePath}::resource.${name}`,
        filePath, startLine: line, endLine, startColumn: 0, endColumn: match[0].length,
        language: 'hcl', updatedAt: now,
        signature: `resource "${resourceType}" "${resourceName}"`,
      });
    }

    // Extract data blocks: data "aws_type" "name" {
    const dataPattern = /^data\s+"([^"]+)"\s+"([^"]+)"\s*\{/gm;
    while ((match = dataPattern.exec(content)) !== null) {
      const line = content.slice(0, match.index).split('\n').length;
      const dataType = match[1]!;
      const dataName = match[2]!;
      const name = `${dataType}.${dataName}`;
      const endLine = findBlockEnd(content, match.index + match[0].length);
      nodes.push({
        id: `data:${filePath}:${name}:${line}`,
        kind: 'variable',
        name: `data.${name}`,
        qualifiedName: `${filePath}::data.${name}`,
        filePath, startLine: line, endLine, startColumn: 0, endColumn: match[0].length,
        language: 'hcl', updatedAt: now,
        signature: `data "${dataType}" "${dataName}"`,
      });
    }

    // Extract module blocks: module "name" {
    const modulePattern = /^module\s+"([^"]+)"\s*\{/gm;
    while ((match = modulePattern.exec(content)) !== null) {
      const line = content.slice(0, match.index).split('\n').length;
      const moduleName = match[1]!;
      const endLine = findBlockEnd(content, match.index + match[0].length);
      nodes.push({
        id: `module:${filePath}:${moduleName}:${line}`,
        kind: 'namespace',
        name: `module.${moduleName}`,
        qualifiedName: `${filePath}::module.${moduleName}`,
        filePath, startLine: line, endLine, startColumn: 0, endColumn: match[0].length,
        language: 'hcl', updatedAt: now,
        signature: `module "${moduleName}"`,
      });
    }

    // Extract variable blocks: variable "name" {
    const variablePattern = /^variable\s+"([^"]+)"\s*\{/gm;
    while ((match = variablePattern.exec(content)) !== null) {
      const line = content.slice(0, match.index).split('\n').length;
      const varName = match[1]!;
      const endLine = findBlockEnd(content, match.index + match[0].length);
      nodes.push({
        id: `variable:${filePath}:${varName}:${line}`,
        kind: 'variable',
        name: `var.${varName}`,
        qualifiedName: `${filePath}::var.${varName}`,
        filePath, startLine: line, endLine, startColumn: 0, endColumn: match[0].length,
        language: 'hcl', updatedAt: now,
        signature: `variable "${varName}"`,
      });
    }

    // Extract output blocks: output "name" {
    const outputPattern = /^output\s+"([^"]+)"\s*\{/gm;
    while ((match = outputPattern.exec(content)) !== null) {
      const line = content.slice(0, match.index).split('\n').length;
      const outputName = match[1]!;
      const endLine = findBlockEnd(content, match.index + match[0].length);
      nodes.push({
        id: `output:${filePath}:${outputName}:${line}`,
        kind: 'variable',
        name: `output.${outputName}`,
        qualifiedName: `${filePath}::output.${outputName}`,
        filePath, startLine: line, endLine, startColumn: 0, endColumn: match[0].length,
        language: 'hcl', updatedAt: now,
        signature: `output "${outputName}"`,
        isExported: true,
      });
    }

    // Extract locals block entries: locals { name = ... }
    const localsPattern = /^locals\s*\{/gm;
    while ((match = localsPattern.exec(content)) !== null) {
      const blockStart = match.index + match[0].length;
      const blockContent = extractBlock(content, blockStart);
      const localPattern = /^\s+(\w+)\s*=/gm;
      let localMatch: RegExpExecArray | null;
      while ((localMatch = localPattern.exec(blockContent)) !== null) {
        const localLine = content.slice(0, blockStart).split('\n').length +
          blockContent.slice(0, localMatch.index).split('\n').length - 1;
        const localName = localMatch[1]!;
        nodes.push({
          id: `local:${filePath}:${localName}:${localLine}`,
          kind: 'constant',
          name: `local.${localName}`,
          qualifiedName: `${filePath}::local.${localName}`,
          filePath, startLine: localLine, endLine: localLine, startColumn: 0, endColumn: localMatch[0].length,
          language: 'hcl', updatedAt: now,
        });
      }
    }

    // Extract API Gateway routes from aws_api_gateway_resource + aws_api_gateway_method
    const apiResourcePattern = /resource\s+"aws_api_gateway_resource"\s+"([^"]+)"[\s\S]*?path_part\s*=\s*"([^"]+)"/g;
    while ((match = apiResourcePattern.exec(content)) !== null) {
      const line = content.slice(0, match.index).split('\n').length;
      const routePath = `/${match[2]}`;
      const name = `RESOURCE ${routePath}`;
      nodes.push({
        id: `route:${filePath}:RESOURCE:${routePath}:${line}`,
        kind: 'route', name,
        qualifiedName: `${filePath}::${name}`,
        filePath, startLine: line, endLine: line, startColumn: 0, endColumn: match[0].length,
        language: 'hcl', updatedAt: now,
      });
    }

    const apiMethodPattern = /resource\s+"aws_api_gateway_method"\s+"([^"]+)"[\s\S]*?http_method\s*=\s*"([^"]+)"/g;
    while ((match = apiMethodPattern.exec(content)) !== null) {
      const line = content.slice(0, match.index).split('\n').length;
      const method = match[2]!;
      const name = `${method} (api_gateway_method.${match[1]})`;
      nodes.push({
        id: `route:${filePath}:${method}:${match[1]}:${line}`,
        kind: 'route', name,
        qualifiedName: `${filePath}::${name}`,
        filePath, startLine: line, endLine: line, startColumn: 0, endColumn: match[0].length,
        language: 'hcl', updatedAt: now,
      });
    }

    return nodes;
  },
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function findBlockEnd(content: string, startOffset: number): number {
  let depth = 1;
  for (let i = startOffset; i < content.length; i++) {
    if (content[i] === '{') depth++;
    else if (content[i] === '}') {
      depth--;
      if (depth === 0) return content.slice(0, i).split('\n').length;
    }
  }
  return content.slice(0, startOffset).split('\n').length;
}

function extractBlock(content: string, startOffset: number): string {
  let depth = 1;
  for (let i = startOffset; i < content.length; i++) {
    if (content[i] === '{') depth++;
    else if (content[i] === '}') {
      depth--;
      if (depth === 0) return content.slice(startOffset, i);
    }
  }
  return content.slice(startOffset);
}

function resolveResource(name: string, context: ResolutionContext): string | null {
  for (const file of context.getAllFiles()) {
    if (!file.endsWith('.tf')) continue;
    const node = context.getNodesInFile(file).find(n => n.name === name);
    if (node) return node.id;
  }
  return null;
}

function resolveModule(name: string, context: ResolutionContext): string | null {
  const fullName = `module.${name}`;
  for (const file of context.getAllFiles()) {
    if (!file.endsWith('.tf')) continue;
    const node = context.getNodesInFile(file).find(n => n.name === fullName);
    if (node) return node.id;
  }
  return null;
}

function resolveVariable(name: string, context: ResolutionContext): string | null {
  const fullName = `var.${name}`;
  for (const file of context.getAllFiles()) {
    if (!file.endsWith('.tf')) continue;
    const node = context.getNodesInFile(file).find(n => n.name === fullName);
    if (node) return node.id;
  }
  return null;
}
