/**
 * Calculate classes needed to reach threshold.
 * Returns -1 if threshold=100% and absences exist (impossible).
 */
export function classesNeeded(attended: number, total: number, threshold: number): number {
  if (total === 0) return 0;
  if (attended / total >= threshold) return 0;
  if (threshold >= 1.0) return attended < total ? -1 : 0;
  return Math.max(0, Math.ceil((threshold * total - attended) / (1 - threshold)));
}

/**
 * Calculate safe classes to skip before falling below threshold.
 */
export function safeToSkip(attended: number, total: number, threshold: number): number {
  if (total === 0) return 0;
  if (threshold <= 0) return 999;
  return Math.max(0, Math.floor((attended - threshold * total) / threshold));
}
