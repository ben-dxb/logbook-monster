'use strict';
/* The history CSV reader (public/gymcsv.js) on the export layouts of Setgraph, Strong and Hevy. */
const { test } = require('node:test');
const assert = require('node:assert');
const GymCsv = require('../public/gymcsv.js');
const { parseCsv, readWhen, readHistory, importBatches } = GymCsv;

test('CSV fields: quotes, commas and line breaks inside quotes, semicolons, BOM', () => {
  assert.deepStrictEqual(parseCsv('﻿a,b,c\r\n"x, y","say ""hi""","two\nlines"\r\n\r\n'), [['a', 'b', 'c'], ['x, y', 'say "hi"', 'two\nlines']]);
  assert.deepStrictEqual(parseCsv('a;b\n1,5;2'), [['a', 'b'], ['1,5', '2']]);
});

test('dates and times in the usual export formats', () => {
  assert.strictEqual(readWhen('2026-10-15 17:43:38'), '2026-10-15T17:43:38');
  assert.strictEqual(readWhen('2026-10-15', '5:43 PM'), '2026-10-15T17:43:00');
  assert.strictEqual(readWhen('15/10/2026 17:43', '', 'dmy'), '2026-10-15T17:43:00');
  assert.strictEqual(readWhen('10/15/2026 5:43:38 pm', '', 'mdy'), '2026-10-15T17:43:38');
  assert.strictEqual(readWhen('15 Oct 2026, 17:43'), '2026-10-15T17:43:00');
  assert.strictEqual(readWhen('October 15, 2026 at 12:05 AM'), '2026-10-15T00:05:00');
  assert.strictEqual(readWhen('15 Sept 2026'), '2026-09-15T12:00:00');
  assert.strictEqual(readWhen('2026-02-30'), null);
  assert.strictEqual(readWhen('yesterday'), null);
});

test('Setgraph-style export: separate date and time, labels, lb converted, bad rows listed', () => {
  const csv = [
    'Exercise,Date,Time,Reps,Weight,Unit,Notes,Label',
    'atlantis hack squat,15/10/2026,17:43:38,12,160,kg,,',
    'atlantis hack squat,15/10/2026,17:50:27,8,160,kg,"felt heavy, good depth",',
    'Seated Calf Raise,15/10/2026,18:20:00,15,100,lbs,,Warm-up',
    'Plank,15/10/2026,18:30:00,,,kg,,',
    ',15/10/2026,18:31:00,10,20,kg,,',
    'Curl,31/02/2026,18:32:00,10,20,kg,,',
  ].join('\n');
  const r = readHistory(csv);
  assert.deepStrictEqual(r.sets, [
    { name: 'atlantis hack squat', reps: 12, kg: 160, note: '', at: '2026-10-15T17:43:38' },
    { name: 'atlantis hack squat', reps: 8, kg: 160, note: 'felt heavy, good depth', at: '2026-10-15T17:50:27' },
    { name: 'Seated Calf Raise', reps: 15, kg: 45.36, note: 'Warm-up', at: '2026-10-15T18:20:00' },
  ]);
  assert.deepStrictEqual(r.skipped.map(s => s.line), [5, 6, 7]);
  assert.strictEqual(r.dateOrder, 'dmy');
  assert.strictEqual(r.dateOrderAsk, false);
  assert.strictEqual(r.unitAsk, false);
  assert.deepStrictEqual([r.from, r.to, r.names.length], ['2026-10-15', '2026-10-15', 2]);
});

test('Strong export: one time per workout, set order keeps sets in order, weight unit asked', () => {
  const csv = [
    'Date,Workout Name,Duration,Exercise Name,Set Order,Weight,Reps,Distance,Seconds,Notes,Workout Notes,RPE',
    '2026-03-04 18:30:00,Legs,1h,Squat (Barbell),2,100,8,0,0,,,',
    '2026-03-04 18:30:00,Legs,1h,Squat (Barbell),1,100,10,0,0,,,',
    '2026-03-04 18:30:00,Legs,1h,Squat (Barbell),3,100,10,0,0,,,',
  ].join('\n');
  const r = readHistory(csv);
  assert.deepStrictEqual(r.sets.map(s => s.reps), [10, 8, 10]);
  assert.strictEqual(r.columns.exercise, 'Exercise Name');
  assert.strictEqual(r.unitAsk, true);
  assert.deepStrictEqual(readHistory(csv, { unit: 'lb' }).sets.map(s => s.kg), [45.36, 45.36, 45.36]);
});

test('Hevy export: workout title is not the exercise, weight_kg, normal set type dropped', () => {
  const csv = [
    'title,start_time,end_time,description,exercise_title,superset_id,exercise_notes,set_index,set_type,weight_kg,reps,distance_km,duration_seconds,rpe',
    '"Push A","5 Jan 2026, 18:30","5 Jan 2026, 19:30",,Bench Press (Barbell),,,0,warmup,40,10,,,',
    '"Push A","5 Jan 2026, 18:30","5 Jan 2026, 19:30",,Bench Press (Barbell),,,1,normal,80,8,,,',
  ].join('\n');
  const r = readHistory(csv);
  assert.deepStrictEqual(r.sets.map(s => [s.name, s.kg, s.note, s.at]), [
    ['Bench Press (Barbell)', 40, 'warmup', '2026-01-05T18:30:00'], ['Bench Press (Barbell)', 80, '', '2026-01-05T18:30:00']]);
});

test('ambiguous day/month dates are flagged; a date above 12 settles it', () => {
  const amb = 'Exercise,Date,Reps,Weight\nRow,03/04/2026,10,50\n';
  assert.strictEqual(readHistory(amb).dateOrderAsk, true);
  assert.strictEqual(readHistory(amb).sets[0].at, '2026-04-03T12:00:00');
  assert.strictEqual(readHistory(amb, { dateOrder: 'mdy' }).sets[0].at, '2026-03-04T12:00:00');
  const us = amb + 'Row,03/25/2026,10,50\n';
  assert.deepStrictEqual([readHistory(us).dateOrder, readHistory(us).dateOrderAsk], ['mdy', false]);
  assert.throws(() => readHistory('Foo,Bar\n1,2\n'), /exercise, date, reps/);
});

test('batches stay under the size limit and never split sets done at the same moment', () => {
  const sets = [];
  for (let i = 0; i < 50; i++) sets.push({ name: 'Squat', reps: 5, kg: 100, note: 'x'.repeat(50), at: `2026-01-01T10:00:${String(Math.floor(i / 10)).padStart(2, '0')}` });
  const b = importBatches(sets, 1000);
  assert.strictEqual(b.flat().length, 50);
  b.forEach((x, i) => { if (i) assert.notStrictEqual(x[0].at, b[i - 1].at(-1).at); });
});

test('many short sets: every batch fits the server (3000 sets, 300 kB of JSON)', () => {
  const sets = [];
  for (let i = 0; i < 6000; i++) sets.push({ name: 'Row', reps: 5, kg: 60, at: `2026-01-05T10:${String(Math.floor(i / 60) % 60).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}` });
  const b = GymCsv.importBatches(sets);
  assert.strictEqual(b.flat().length, 6000);
  assert.ok(b.length >= 3);
  for (const x of b) {
    assert.ok(x.length <= 3000, `batch of ${x.length} sets`);
    assert.ok(JSON.stringify({ sets: x }).length <= 300 * 1024, 'batch over 300 kB');
  }
});

test('real Setgraph export layout: both lb and kg columns, decimal reps, durations', () => {
  const csv = [
    'Exercise,Date,Repetitions,Weight (lb),Weight (kg),Duration (seconds),Duration (formatted),Note,Label',
    'Lat Pulldown,2024-07-13 18:19:42,8.0,159.83527046332387,72.5,,,,',
    'Side Lateral Raises,2024-07-13 18:28:48,9.0,26.45549304220533,12.0,,,+3 half reps,',
    'Plank,2024-07-13 18:40:00,,,,60,1:00,,',
  ].join('\n');
  const r = readHistory(csv);
  assert.strictEqual(r.columns.weight, 'Weight (kg)');
  assert.strictEqual(r.unitAsk, false);
  assert.deepStrictEqual(r.sets, [
    { name: 'Lat Pulldown', reps: 8, kg: 72.5, note: '', at: '2024-07-13T18:19:42' },
    { name: 'Side Lateral Raises', reps: 9, kg: 12, note: '+3 half reps', at: '2024-07-13T18:28:48' },
  ]);
  assert.deepStrictEqual(r.skipped.map(s => s.line), [4]);   /* a timed set has no reps */
});

test('numbers: decimal commas and thousands separators read on purpose, letters and ambiguous ones left out with a reason', () => {
  const { readNum, decimalMark, AMBIGUOUS } = GymCsv;
  assert.deepStrictEqual(['12.5', '12,5', '1,025.5', '1.025,5', '1 025', '1,000,000', '0,025', '80 kg', '-20', ''].map(v => readNum(v)),
    [12.5, 12.5, 1025.5, 1025.5, 1025, 1000000, 0.025, 80, -20, null]);
  assert.ok(Number.isNaN(readNum('abc')) && Number.isNaN(readNum('80e')) && Number.isNaN(readNum('1,2,3')));
  assert.strictEqual(readNum('1,025'), AMBIGUOUS);
  assert.deepStrictEqual([readNum('1,025', '.'), readNum('1,025', ','), readNum('1.025'), readNum('1.025', ',')], [1025, 1.025, 1.025, 1025]);
  assert.deepStrictEqual([decimalMark(['12,5', '1,025']), decimalMark(['12.5', '1,025']), decimalMark(['1,025']), decimalMark(['12,5', '12.5'])], [',', '.', null, null]);
  /* a comma-separated file: "1,025" lb is a thousand and twenty-five; reps "abc" is not 0 reps */
  let r = readHistory('Exercise,Date,Reps,Weight (lbs)\nLeg press,2026-10-01 10:00,10,"1,025"\nCurl,2026-10-01 10:05,abc,20\n');
  assert.deepStrictEqual(r.sets.map(s => [s.name, s.reps, s.kg]), [['Leg press', 10, 464.93]]);
  assert.deepStrictEqual(r.skipped, [{ line: 3, why: 'Curl: reps “abc” isn’t a number' }]);
  /* semicolons: a decimal comma elsewhere in the file makes 1,025 one point oh two five, a decimal point makes it 1025;
     alone it is reported, not guessed */
  r = readHistory('Exercise;Date;Reps;Weight\nPress;2026-10-01 10:00;10;1,025\nCurl;2026-10-01 10:05;8;12,5\n');
  assert.deepStrictEqual(r.sets.map(s => s.kg), [1.02, 12.5]);
  r = readHistory('Exercise;Date;Reps;Weight\nPress;2026-10-01 10:00;10;1,025\nCurl;2026-10-01 10:05;8;1,250.5\n');
  assert.deepStrictEqual(r.sets.map(s => s.kg), [1025, 1250.5]);
  r = readHistory('Exercise;Date;Reps;Weight\nPress;2026-10-01 10:00;10;1,025\n');
  assert.deepStrictEqual(r.sets, []);
  assert.match(r.skipped[0].why, /could be 1025 or 1\.025/);
});
