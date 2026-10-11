// 项目自绘几何风景，不使用第三方素材。运行：pnpm exec node scripts/generate-demo-images.mjs
import { mkdirSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const directory = new URL('../public/demo-images/', import.meta.url);
mkdirSync(directory, { recursive: true });
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const name = Buffer.from(type);
  const size = Buffer.alloc(4);
  size.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([size, name, data, checksum]);
}
function landscape(width, height, number) {
  const pixels = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const horizontal = x / width;
      const vertical = y / height;
      const sun = Math.hypot(horizontal - .72, vertical - .24) < .10;
      const mountain = vertical > .65 - .22 * Math.sin(horizontal * 9 + number);
      const color = sun ? [255, 221, 125] : mountain ? [40 + number * 7, 108, 105]
        : [125 + number * 4, 175 + Math.floor(vertical * 35), 235];
      const offset = y * (width * 3 + 1) + 1 + x * 3;
      color.forEach((value, index) => { pixels[offset + index] = value; });
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header),
    chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
}
for (let number = 1; number <= 12; number++) {
  const portrait = number === 12;
  for (const [kind, width, height] of [['thumb', portrait ? 90 : 240, portrait ? 240 : number === 11 ? 120 : 180],
    ['preview', portrait ? 600 : 1200, portrait ? 1600 : number === 11 ? 600 : 900]]) {
    writeFileSync(new URL(`landscape-${number}-${kind}.v1.png`, directory), landscape(width, height, number));
  }
}
