// Custom-named session guard — deliberately not named "auth"/"guard"/etc,
// so AttackSurfaceAnalyzer's AUTH_PATTERNS heuristic can't recognize it.
// This is exactly the false-negative gap securityAuthDetectionMode: 'jev' backstops.
export function withSession(req: unknown, res: unknown, next: () => void): void {
  next();
}
