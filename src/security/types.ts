/**
 * KiroGraph-Sec Type Definitions
 *
 * Interfaces for the security analysis module including manifest parsing,
 * vulnerability detection, reachability analysis, and CycloneDX export.
 */

// ── Manifest Parsing ──────────────────────────────────────────────────────────

export interface ParsedDependency {
  name: string;
  declaredConstraint: string;
  resolvedVersion?: string; // from lock file
  scope: 'production' | 'development' | 'optional';
  ecosystem: string;
  sourceManifest: string; // relative path to declaring manifest
  license?: string; // SPDX expression or license name, if available in the manifest
}

export interface ManifestParseResult {
  dependenciesCreated: number;
  manifestsParsed: number;
  warnings: Array<{ file: string; line?: number; message: string }>;
  errors: Array<{ file: string; message: string }>;
}

// ── Dependency Graph Integration ──────────────────────────────────────────────

export interface IntegrationResult {
  importsEdgesCreated: number;
  referencesEdgesCreated: number;
}

export interface TransitiveResult {
  dependsOnEdgesCreated: number;
  incompleteNodes: string[]; // nodes marked with transitive_status=incomplete
}

export interface CleanupResult {
  nodesRemoved: number;
  edgesRemoved: number;
}

// ── Vulnerability Database ────────────────────────────────────────────────────

export interface CVERecord {
  id: string; // e.g. "CVE-2023-12345"
  severity: number | null; // CVSS base score (0.0–10.0), or null when unknown
  affectedVersionRanges: VersionRange[];
  fixedVersion?: string;
  summary: string;
}

export interface VersionRange {
  introduced?: string;
  fixed?: string;
  lastAffected?: string;
}

export interface EnrichmentResult {
  vulnerabilitiesFound: number;
  dependenciesChecked: number;
  errors: Array<{ dependency: string; database: string; error: string }>;
  staleNodes: string[]; // nodes where vulnDataStale was set
}

// ── Reachability Analysis ─────────────────────────────────────────────────────

export type ReachabilityVerdict = 'affected' | 'not_affected' | 'under_investigation';

export interface ReachabilityPath {
  entryPoint: string; // node ID of the entry point
  path: string[]; // ordered list of node IDs from entry to dependency
}

export interface ReachabilityResult {
  verdict: ReachabilityVerdict;
  paths: ReachabilityPath[];
  unresolvedSymbols: string[]; // up to 50, for under_investigation
  reachingEntryPointCount: number;
}

export interface ImpactSummary {
  affectedLayers: string[]; // e.g. ['api', 'service']
  affectedEntryPoints: string[]; // node IDs of reaching entry points
  distinctPathCount: number; // capped at 100
}

// ── Security Pipeline ─────────────────────────────────────────────────────────

export interface SecurityResult {
  manifestsDiscovered: number;
  dependenciesCreated: number;
  vulnerabilitiesFound: number;
  affectedCount: number;
  notAffectedCount: number;
  underInvestigationCount: number;
  duration: number;
}

// ── CycloneDX SBOM Export ─────────────────────────────────────────────────────

export interface SBOMMetadata {
  toolName: string;
  toolVersion: string;
  timestamp: string; // ISO 8601 UTC
  projectName: string;
}

export interface CycloneDXSBOM {
  bomFormat: 'CycloneDX';
  specVersion: '1.5';
  version: number;
  metadata: Record<string, unknown>;
  components: CycloneDXComponent[];
  dependencies: CycloneDXDependencyEntry[];
}

export interface CycloneDXComponent {
  type: 'library';
  name: string;
  version: string;
  purl: string;
  scope?: 'required' | 'optional';
  properties?: Array<{ name: string; value: string }>;
}

export interface CycloneDXDependencyEntry {
  ref: string;
  dependsOn?: string[];
}

// ── CycloneDX VEX Export ──────────────────────────────────────────────────────

export interface CycloneDXVEX {
  bomFormat: 'CycloneDX';
  specVersion: '1.5';
  version: number;
  metadata: Record<string, unknown>;
  vulnerabilities: CycloneDXVulnerability[];
}

export interface CycloneDXVulnerability {
  id: string;
  source?: { name: string; url?: string };
  ratings?: Array<{ score: number; severity?: string; method?: string }>;
  analysis?: {
    state: 'affected' | 'not_affected' | 'under_investigation';
    justification?: string;
    detail?: string;
  };
  affects?: Array<{ ref: string }>;
}
