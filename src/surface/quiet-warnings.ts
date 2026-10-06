/**
 * Must be the CLI's first import, so it runs before any dependency loads.
 *
 * DEP0040 (`punycode` is deprecated) comes from a transitive dependency we
 * don't control — @nut-tree-fork/nut-js → jimp → node-fetch@2 → whatwg-url@5
 * → tr46@0.0.3 — and printed on every `clawdcursor` command, including the
 * consent step a new user runs first. Only that one code is dropped; every
 * other warning still prints.
 */
const emit = process.emitWarning.bind(process);

process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
  const opt = rest[0];
  const code = typeof opt === 'object' && opt !== null ? (opt as { code?: string }).code : rest[1];
  if (code === 'DEP0040') return;
  return (emit as (...a: unknown[]) => void)(warning, ...rest);
}) as typeof process.emitWarning;

export {};
