'use strict';
/* CLAUDE.md: problems are said next to the control (noteBy / fieldError) or in ask(), never alert() / confirm() / prompt(). */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

test('no alert(), confirm() or prompt() in the pages', () => {
  const dir = path.join(__dirname, '..', 'public'), bad = [];
  for (const f of fs.readdirSync(dir).filter(f => /\.(js|html)$/.test(f))) {
    fs.readFileSync(path.join(dir, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, c => c.replace(/[^\n]/g, ' ')).split('\n')   /* not in comments */.forEach((l, i) => {
      if (/(^|[^\w.$-])(window\.)?(alert|confirm|prompt)\s*\(/.test(l)) bad.push(`${f}:${i + 1}: ${l.trim().slice(0, 100)}`);
    });
  }
  assert.deepStrictEqual(bad, []);
});
