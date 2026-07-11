/**
 * JD filters that should skip resume generation entirely.
 */

const CLEARANCE_PATTERNS: RegExp[] = [
  /\bsecurity\s+clearance\b/i,
  /\bsecret\s+clearance\b/i,
  /\btop[\s-]?secret\b/i,
  /\bts\s*\/\s*sci\b/i,
  /\bts\/sci\b/i,
  /\bactive\s+clearance\b/i,
  /\bclearance\s+required\b/i,
  /\brequires?\b[\s\S]{0,60}\bclearance\b/i,
  /\bmust\s+(hold|have|possess|maintain)\b[\s\S]{0,50}\bclearance\b/i,
  /\b(dod|doe|us\s+government)\s+clearance\b/i,
  /\bpublic\s+trust\s+clearance\b/i,
  /\bpolygraph\b/i,
];

/** Returns true when the JD indicates a security clearance requirement. */
export function requiresSecurityClearance(text: string): boolean {
  if (!text?.trim()) return false;
  return CLEARANCE_PATTERNS.some((re) => re.test(text));
}

export function securityClearanceSkipReason(): string {
  return 'Skipped — JD requires security clearance (keyword match). Resume not generated.';
}
