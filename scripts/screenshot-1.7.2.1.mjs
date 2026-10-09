// Run outside the restricted sandbox:
// xvfb-run -a node scripts/screenshot-1.7.2.1.mjs
// Uses only local simulated ChatGPT pages and the unpacked extension. Also
// asserts A/B/C isolation and capture date labels before saving docs/*.png.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const { stdout, stderr } = await promisify(execFile)(process.execPath,
  [new URL('./e2e-chatgpt.mjs', import.meta.url).pathname, '--spa-only'],
  { maxBuffer: 8 * 1024 * 1024 });
process.stdout.write(stdout);
process.stderr.write(stderr);
