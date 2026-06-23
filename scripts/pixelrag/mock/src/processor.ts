import * as fs from 'fs';
import * as path from 'path';

// Load scanned annual report (complex layout — multi-column, charts)
const reportBuffer = fs.readFileSync('./data/annual-report.pdf');

// Load technical specification (text-heavy, single column)
const specBuffer = fs.readFileSync('./data/tech-spec.pdf');

export function processReports(outputDir: string): void {
  const reportPath = path.join(outputDir, 'annual-report.pdf');
  const specPath   = path.join(outputDir, 'tech-spec.pdf');
  fs.writeFileSync(reportPath, reportBuffer);
  fs.writeFileSync(specPath, specBuffer);
}

export function getPdfPaths(): string[] {
  return [
    './data/annual-report.pdf',
    './data/tech-spec.pdf',
  ];
}
