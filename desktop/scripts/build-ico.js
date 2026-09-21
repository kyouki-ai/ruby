// Packs a set of square PNGs into a single multi-resolution .ico file.
// Modern Windows (Vista+) accepts PNG-compressed images inside ICO entries
// directly, so no separate BMP/DIB encoding is needed.
const fs = require('fs');
const path = require('path');

const partsDir = path.join(__dirname, '..', 'assets', 'icon-parts');
const sizes = [16, 32, 48, 256];
const outPath = path.join(__dirname, '..', 'assets', 'icon.ico');

const images = sizes.map((size) => ({
  size,
  data: fs.readFileSync(path.join(partsDir, `icon-${size}.png`)),
}));

const headerSize = 6;
const dirEntrySize = 16;
let offset = headerSize + dirEntrySize * images.length;

const header = Buffer.alloc(headerSize);
header.writeUInt16LE(0, 0); // reserved
header.writeUInt16LE(1, 2); // type: icon
header.writeUInt16LE(images.length, 4);

const dirEntries = [];
const dataChunks = [];

for (const img of images) {
  const entry = Buffer.alloc(dirEntrySize);
  const dim = img.size >= 256 ? 0 : img.size; // 0 means 256 in ICO format
  entry.writeUInt8(dim, 0); // width
  entry.writeUInt8(dim, 1); // height
  entry.writeUInt8(0, 2); // color palette
  entry.writeUInt8(0, 3); // reserved
  entry.writeUInt16LE(1, 4); // color planes
  entry.writeUInt16LE(32, 6); // bits per pixel
  entry.writeUInt32LE(img.data.length, 8); // image data size
  entry.writeUInt32LE(offset, 12); // offset of image data
  offset += img.data.length;
  dirEntries.push(entry);
  dataChunks.push(img.data);
}

fs.writeFileSync(outPath, Buffer.concat([header, ...dirEntries, ...dataChunks]));
console.log('Wrote', outPath);
