/**
 * Build / check the MCP schema snapshot.
 *
 * Thin entrypoint around src/schema/snapshot.ts. Run without args to check;
 * pass --write to intentionally update the committed snapshot (rare; must be
 * approved in PR review since this releases the MCP contract freeze).
 */

import {
  currentSnapshot,
  readStoredSnapshot,
  toolCounts,
  writeSnapshot,
} from '../src/schema/snapshot';

async function main(): Promise<void> {
  const writeMode = process.argv.includes('--write');
  const current = await currentSnapshot();

  if (writeMode) {
    writeSnapshot(current);
    process.stdout.write(`Wrote schema.snapshot.json (${toolCounts(current)} tools)\n`);
    return;
  }

  const stored = readStoredSnapshot();
  if (stored === null) {
    process.stderr.write('schema.snapshot.json missing. Generate it with: npm run test:mcp-schema-snapshot:update\n');
    process.exit(2);
  }

  if (stored !== current) {
    process.stderr.write('What agents receive from initialize / tools/list has drifted from the committed snapshot.\n');
    process.stderr.write('If this change is intentional, update the snapshot with:\n');
    process.stderr.write('  npm run test:mcp-schema-snapshot:update\n');
    process.stderr.write('\nDiff (first 2000 chars):\n');
    const a = stored.split('\n');
    const b = current.split('\n');
    const maxLen = Math.max(a.length, b.length);
    let buf = '';
    for (let i = 0; i < maxLen && buf.length < 2000; i++) {
      if (a[i] !== b[i]) {
        buf += `L${i + 1}- ${a[i] ?? '(missing)'}\n`;
        buf += `L${i + 1}+ ${b[i] ?? '(missing)'}\n`;
      }
    }
    process.stderr.write(buf);
    process.exit(1);
  }

  process.stdout.write(`MCP schema snapshot OK (${toolCounts(current)} tools)\n`);
}

void main().catch(err => { process.stderr.write(`${err instanceof Error ? err.stack : String(err)}\n`); process.exit(1); });
