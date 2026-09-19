import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const read = (path) => readFileSync(join(root, path), 'utf8');
const manifest = JSON.parse(read('manifest.json'));
assert.equal(manifest.manifest_version, 3);
assert.equal(manifest.action.default_popup, 'options/popup.html');
assert.deepEqual(manifest.permissions, ['storage']);
assert.deepEqual(manifest.host_permissions.sort(), ['https://api.typesafe.ai/*', 'https://openrouter.ai/*']);
assert.deepEqual(manifest.content_scripts[0].matches, ['https://x.com/*', 'https://twitter.com/*']);

const files = readdirSync(root, { recursive: true }).filter((path) => path.endsWith('.js'));
for (const file of files) execFileSync(process.execPath, ['--check', join(root, file)]);

const controls = ['settings-form', 'provider', 'api-key', 'model', 'threshold', 'prompt', 'blur-enabled', 'context-guard-enabled', 'remote-analysis-enabled', 'toggle-key', 'test-connection', 'status'];
for (const page of ['options/options.html', 'options/popup.html']) {
  const html = read(page);
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
  assert.equal(new Set(ids).size, ids.length, `${page}: duplicate ids`);
  for (const id of controls) assert.ok(ids.includes(id), `${page}: missing ${id}`);
  for (const [, src] of html.matchAll(/(?:src|href)="([^":]+\.(?:js|css))"/g)) {
    assert.ok(existsSync(join(root, dirname(page), src)), `${page}: missing ${src}`);
  }
  assert.match(html, /Flouter les posts détectés comme slop/);
  assert.doesNotMatch(html, /id="blur-threshold"/);
  assert.ok(html.indexOf('src/shared.js') < html.indexOf('src="options.js"'), 'Shared configuration must load before options');
  assert.doesNotMatch(html, /<script[^>]*>\s*[^<\s]/);
  assert.doesNotMatch(html, /\son\w+=/i);
}
assert.match(read('src/content.css'), /prefers-reduced-motion/);
assert.doesNotMatch(read('options/options.js'), /\bfetch\(/);
console.log(`PASS: Manifest MV3, 2 providers, 2 pages, controls, local assets, ${files.length} JavaScript syntax checks, reduced motion.`);
