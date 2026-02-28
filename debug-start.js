// Debug wrapper to catch why the process exits
const { execSync, spawn } = require('child_process');

console.log('[DEBUG] Starting clawd-cursor with exit monitoring...');

const child = spawn('node', ['dist/index.js', 'start', '--port', '3851'], {
  cwd: __dirname,
  stdio: 'inherit',
  env: { ...process.env },
});

child.on('exit', (code, signal) => {
  console.log(`\n[DEBUG] Process exited! code=${code} signal=${signal}`);
  console.log('[DEBUG] Timestamp:', new Date().toISOString());
});

child.on('error', (err) => {
  console.log(`\n[DEBUG] Process error:`, err);
});
