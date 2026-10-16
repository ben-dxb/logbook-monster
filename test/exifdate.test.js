'use strict';
/* Reading the date a picture was taken from its own data (public/exifdate.js), for bulk photo uploads. */
const { test } = require('node:test');
const assert = require('node:assert');
const ExifDate = require('../public/exifdate.js');

/* a TIFF block with the given ASCII tags: ifd0 in IFD0, exif in the Exif IFD */
function tiff({ ifd0 = {}, exif = {} }, le = true) {
  const out = [], u16 = v => le ? [v & 255, v >> 8] : [v >> 8, v & 255];
  const u32 = v => le ? [v & 255, v >> 8 & 255, v >> 16 & 255, v >>> 24] : [v >>> 24, v >> 16 & 255, v >> 8 & 255, v & 255];
  const e0 = Object.entries(ifd0), e1 = Object.entries(exif), hasExif = e1.length > 0;
  const n0 = e0.length + (hasExif ? 1 : 0), ifd0At = 8, exifAt = ifd0At + 2 + n0 * 12 + 4, dataAt0 = exifAt + (hasExif ? 2 + e1.length * 12 + 4 : 0);
  let dataAt = dataAt0; const data = [];
  const entry = ([tag, s]) => { const bytes = [...Buffer.from(s + '\0', 'latin1')], at = dataAt; data.push(...bytes); dataAt += bytes.length; return [...u16(+tag), ...u16(2), ...u32(bytes.length), ...u32(at)]; };
  out.push(...(le ? [0x49, 0x49] : [0x4d, 0x4d]), ...u16(42), ...u32(ifd0At));
  out.push(...u16(n0)); e0.forEach(e => out.push(...entry(e)));
  if (hasExif) out.push(...u16(0x8769), ...u16(4), ...u32(1), ...u32(exifAt));
  out.push(...u32(0));
  if (hasExif) { out.push(...u16(e1.length)); e1.forEach(e => out.push(...entry(e))); out.push(...u32(0)); }
  return Buffer.from([...out, ...data]);
}
function jpeg(t) {
  const body = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), t]), len = body.length + 2;
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe1, len >> 8, len & 255]), body, Buffer.from([0xff, 0xda, 0, 2]), Buffer.alloc(64, 7)]);
}

test('JPEG: DateTimeOriginal wins over DateTime, either byte order', () => {
  const t = { ifd0: { 0x0132: '2026:10:14 09:00:00' }, exif: { 0x9003: '2026:09:01 07:30:12', 0x9004: '2026:09:02 07:30:12' } };
  assert.strictEqual(ExifDate.fromBytes(jpeg(tiff(t))), '2026-09-01');
  assert.strictEqual(ExifDate.fromBytes(jpeg(tiff(t, false))), '2026-09-01');
  assert.strictEqual(ExifDate.fromBytes(jpeg(tiff({ ifd0: { 0x0132: '2025:12:31 23:59:59' } }))), '2025-12-31');
  assert.strictEqual(ExifDate.fromBytes(jpeg(tiff({ exif: { 0x9004: '2024:02:29 10:00:00' } }))), '2024-02-29');
});

test('PNG eXIf chunk and XMP dates', () => {
  const t = tiff({ exif: { 0x9003: '2026:03:05 12:00:00' } });
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from([0, 0, 0, t.length]), Buffer.from('eXIf'), t]);
  assert.strictEqual(ExifDate.fromBytes(png), '2026-03-05');
  assert.strictEqual(ExifDate.fromBytes(Buffer.from('<x:xmpmeta><rdf:Description photoshop:DateCreated="2023-07-04T10:11:12"/>')), '2023-07-04');
  assert.strictEqual(ExifDate.fromBytes(Buffer.from('<xmp:CreateDate>2022-01-02T03:04:05Z</xmp:CreateDate>')), '2022-01-02');
});

test('no date, blank or broken dates and junk give null', () => {
  assert.strictEqual(ExifDate.fromBytes(jpeg(tiff({ exif: { 0x9003: '0000:00:00 00:00:00' } }))), null);
  assert.strictEqual(ExifDate.fromBytes(jpeg(tiff({ exif: { 0x9003: '2026:02:30 00:00:00' } }))), null);
  assert.strictEqual(ExifDate.fromBytes(jpeg(tiff({ ifd0: { 0x010f: 'Canon Canon Canon' } }))), null);
  assert.strictEqual(ExifDate.fromBytes(Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0, 20, ...Buffer.from('Exif\0\0II*\0\xff\xff\xff\x7f', 'latin1')])), null);
  assert.strictEqual(ExifDate.fromBytes(Buffer.alloc(0)), null);
  assert.strictEqual(ExifDate.fromBytes(Buffer.alloc(5000, 0x45)), null);
});

test('ofFile reads a Blob', async () => {
  assert.strictEqual(await ExifDate.ofFile(new Blob([jpeg(tiff({ exif: { 0x9003: '2026:10:01 08:00:00' } }))])), '2026-10-01');
  assert.strictEqual(await ExifDate.ofFile(new Blob(['not a picture'])), null);
});
