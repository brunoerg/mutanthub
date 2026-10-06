/** Size limits (in characters) applied to all user-provided text. */
export const LIMITS = {
  title: 140,
  description: 4000,
  code: 20_000,
  diff: 60_000,
  command: 4000,
  environment: 4000,
  notes: 8000,
  log: 60_000,
  comment: 10_000,
  filePath: 1024,
  reviewComment: 2000,
  searchQuery: 200,
  killingTestRef: 500,
  editReason: 1000,
  runRequestNotes: 4000,
} as const;
