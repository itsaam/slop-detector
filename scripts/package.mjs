import { readFileSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, relative } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { createHash } from 'node:crypto';

const root = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
const files = ['manifest.json'];
for (const directory of ['src', 'options', 'icons']) {
  for (const item of readdirSync(join(root, directory), {withFileTypes: true})) {
    if (item.isFile() && /\.(js|css|html|png)$/.test(item.name)) files.push(`${directory}/${item.name}`);
  }
}
files.sort();

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

const localEntries = [];
const centralEntries = [];
let offset = 0;
for (const file of files) {
  const name = Buffer.from(file);
  const data = readFileSync(join(root, file));
  const compressed = deflateRawSync(data, {level: 9});
  const crc = crc32(data);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0x800, 6);
  local.writeUInt16LE(8, 8);
  local.writeUInt16LE(33, 12); // Fixed 1980-01-01 timestamp for repeatable archives.
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(compressed.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(name.length, 26);
  localEntries.push(local, name, compressed);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  local.copy(central, 6, 4, 30);
  central.writeUInt32LE(offset, 42);
  centralEntries.push(central, name);
  offset += local.length + name.length + compressed.length;
}
const directory = Buffer.concat(centralEntries);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0);
end.writeUInt16LE(files.length, 8);
end.writeUInt16LE(files.length, 10);
end.writeUInt32LE(directory.length, 12);
end.writeUInt32LE(offset, 16);
const zip = Buffer.concat([...localEntries, directory, end]);
mkdirSync(join(root, 'dist'), {recursive: true});
const output = join(root, 'dist', `slop-detector-${manifest.version}.zip`);
writeFileSync(output, zip);
console.log(`${relative(root, output)} · ${files.length} files · ${zip.length} bytes`);
console.log(`SHA256 ${createHash('sha256').update(zip).digest('hex')}`);
