import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {inflateRawSync} from 'node:zlib';
import {fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url)));
const packageInfo = JSON.parse(readFileSync(new URL('../package.json', import.meta.url)));
assert.equal(manifest.version, packageInfo.version, 'Versions must agree');
const build = () => {
  execFileSync(process.execPath, ['scripts/package.mjs'], {cwd: root});
  return readFileSync(new URL(`../dist/slop-detector-${manifest.version}.zip`, import.meta.url));
};
const zip = build();
assert.deepEqual(build(), zip, 'Package must be reproducible');

const expected = ['manifest.json', ...Object.values(manifest.icons),
  'options/options.html', 'options/popup.html', 'options/options.css', 'options/options.js',
  'src/shared.js', 'src/background.js', 'src/content.js', 'src/content.css'].sort();
const actual = [];
let offset = 0;
while (zip.readUInt32LE(offset) === 0x04034b50) {
  const method = zip.readUInt16LE(offset + 8);
  const compressedSize = zip.readUInt32LE(offset + 18);
  const size = zip.readUInt32LE(offset + 22);
  const nameLength = zip.readUInt16LE(offset + 26);
  const extraLength = zip.readUInt16LE(offset + 28);
  const name = zip.subarray(offset + 30, offset + 30 + nameLength).toString();
  assert.ok(expected.includes(name), `Unexpected packaged file: ${name}`);
  assert.equal(method, 8);
  const start = offset + 30 + nameLength + extraLength;
  const bytes = inflateRawSync(zip.subarray(start, start + compressedSize));
  assert.equal(bytes.length, size);
  assert.deepEqual(bytes, readFileSync(new URL(`../${name}`, import.meta.url)));
  if (/\.(js|json|html)$/.test(name)) {
    assert.doesNotMatch(bytes.toString(), /DEBUG_FORCE_ALL_SLOP|DEBUG-hover-a8ac|local-hover-test|TEST LOCAL/, `${name}: local diagnostics must not ship`);
  }
  actual.push(name);
  offset = start + compressedSize;
}
assert.deepEqual(actual, expected, 'ZIP must contain only runtime files, with manifest at root');
assert.equal(zip.readUInt32LE(offset), 0x02014b50);
assert.equal(zip.readUInt32LE(zip.length - 22), 0x06054b50);
assert.equal(zip.readUInt16LE(zip.length - 12), expected.length);

for (const [size, path] of Object.entries(manifest.icons)) {
  const png = readFileSync(new URL(`../${path}`, import.meta.url));
  assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.equal(png.readUInt32BE(16), Number(size));
  assert.equal(png.readUInt32BE(20), Number(size));
}
assert.ok(!expected.some((path) => /tests|README|PRIVACY|store|\.git/.test(path)));

for (const [path, width, height] of [
  ['store/promo-440x280.png', 440, 280],
  ['store/screenshot-640x400.png', 640, 400],
]) {
  const png = readFileSync(new URL(`../${path}`, import.meta.url));
  assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', `${path}: PNG required`);
  assert.equal(png.readUInt32BE(16), width, `${path}: incorrect width`);
  assert.equal(png.readUInt32BE(20), height, `${path}: incorrect height`);
  assert.equal(png[24], 8, `${path}: 8 bits per channel required`);
  assert.equal(png[25], 2, `${path}: RGB without an alpha channel required`);
}
console.log(`PASS: Reproducible ZIP, ${expected.length} runtime files, root manifest, matching sources, icon dimensions and 24-bit RGB store images.`);
