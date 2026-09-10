// test_translations.mjs — validate the translation pipeline without Qt.
//
// Called from CTest (see src/tests/CMakeLists.txt). Covers the parts that would
// otherwise fail silently at runtime:
//   1. the generated Chinese catalogue is in sync with its translation map and
//      with the English catalogue's message list,
//   2. its placeholders match the German source exactly (a dropped %1 or %% is a
//      user-visible bug and nothing else would catch it),
//   3. the compiled .qm round-trips every message through a reader that
//      implements Qt's QTranslator lookup algorithm, and rejects unknown keys,
//   4. the binary layout matches what QTranslator expects (magic, block tags,
//      context hash table, sorted hash table).

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { compileQm, decodeQm, parseTs } from '../../tools/build-qm.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const desktopDir = join(here, '..', '..');
const enTs = join(desktopDir, 'translations', 'fmplayeranalyzer_en.ts');
const zhTs = join(desktopDir, 'translations', 'fmplayeranalyzer_zh_CN.ts');

let failures = 0;
const check = (condition, label, detail = '') => {
    if (condition) {
        console.log(`ok   ${label}`);
    } else {
        failures++;
        console.error(`FAIL ${label}${detail ? ` — ${detail}` : ''}`);
    }
};

// --- 1. catalogues agree on the set of messages ------------------------------
check(existsSync(zhTs), 'zh_CN catalogue exists');
const enMessages = parseTs(readFileSync(enTs, 'utf8'));
const zhMessages = parseTs(readFileSync(zhTs, 'utf8'));
check(enMessages.length > 0, `en catalogue parses (${enMessages.length} messages)`);
check(enMessages.length === zhMessages.length,
    'zh_CN covers the same number of messages as en',
    `en=${enMessages.length} zh=${zhMessages.length}`);

const key = (m) => `${m.context}\u0000${m.source}`;
const enKeys = new Set(enMessages.map(key));
const missing = zhMessages.filter((m) => !enKeys.has(key(m)));
check(missing.length === 0, 'zh_CN has no messages absent from en',
    missing.slice(0, 3).map((m) => m.source).join(' | '));
const extra = enMessages.filter((m) => !new Set(zhMessages.map(key)).has(key(m)));
check(extra.length === 0, 'zh_CN has no missing messages',
    extra.slice(0, 3).map((m) => m.source).join(' | '));

// --- 2. every message translated, placeholders preserved ---------------------
const unfinished = zhMessages.filter((m) => m.translation === null);
check(unfinished.length === 0, 'every message is translated',
    unfinished.slice(0, 3).map((m) => m.source).join(' | '));
check(!zhMessages.some((m) => m.type === 'obsolete'), 'no obsolete messages');

const placeholders = (text) => (text.match(/%\d+|%%/g) ?? []).sort().join(',');
const brokenPlaceholders = zhMessages.filter((m) => m.translation !== null
    && placeholders(m.source) !== placeholders(m.translation));
check(brokenPlaceholders.length === 0, 'placeholders (%1, %%, …) preserved',
    brokenPlaceholders.slice(0, 3)
        .map((m) => `${m.source} -> ${m.translation}`).join(' | '));

// Untranslated text would show up as German in a Chinese UI; a translation that
// merely copies the source is almost always an oversight. Tokens that are kept
// verbatim on purpose ("DWRS", abbreviations) are uppercase or contain no
// lowercase letters, so requiring a lowercase word keeps them out of the report.
const unchanged = zhMessages.filter((m) => m.translation === m.source
    && /[a-zäöüß]{3,}/.test(m.source.replace(/<[^>]*>/g, ' ').replace(/%\d+|%%/g, ' ')));
check(unchanged.length === 0, 'no message was left in German',
    unchanged.slice(0, 3).map((m) => m.source).join(' | '));

// --- 3. the compiled .qm round-trips through Qt's lookup algorithm -----------
const language = /<TS[^>]*\blanguage="([^"]*)"/.exec(readFileSync(zhTs, 'utf8'))?.[1];
check(language === 'zh_CN', 'catalogue declares zh_CN', String(language));

const { buffer, stats } = compileQm(zhMessages, language);
check(stats.messages === zhMessages.length, 'all messages compiled',
    `${stats.messages} of ${zhMessages.length}`);

const qm = decodeQm(buffer);
check(qm.language === 'zh_CN', 'qm carries the language code', qm.language);
check(qm.count === stats.messages, 'qm hash table has one entry per message');

let looked = 0;
const mismatches = [];
for (const message of zhMessages) {
    const got = qm.translate(message.context, message.source, message.comment);
    looked++;
    if (got !== message.translation)
        mismatches.push(`${message.context}: ${message.source} -> ${got}`);
}
check(mismatches.length === 0, `all ${looked} lookups resolve via the qm`,
    mismatches.slice(0, 3).join(' | '));

const negatives = [
    ['fm::NoSuchContext', zhMessages[0].source, 'unknown context'],
    [zhMessages[0].context, 'Dieser Quelltext existiert nicht', 'unknown source text'],
];
for (const [context, source, label] of negatives)
    check(qm.translate(context, source) === null, `qm rejects ${label}`);

// --- 4. binary layout -------------------------------------------------------
check(buffer.subarray(0, 16).equals(Buffer.from([
    0x3c, 0xb8, 0x64, 0x18, 0xca, 0xef, 0x9c, 0x95,
    0xcd, 0x21, 0x1c, 0xbf, 0x60, 0xa1, 0xbd, 0xdd])), 'qm magic matches Qt');
const tags = [];
let pos = 16;
while (pos + 5 <= buffer.length) {
    const tag = buffer.readUInt8(pos);
    const length = buffer.readUInt32BE(pos + 1);
    if (!tag || !length) break;
    tags.push(tag);
    pos += 5 + length;
}
check(pos === buffer.length, 'qm block structure consumes the whole file');
check(tags.includes(0xa7) && tags.includes(0x42) && tags.includes(0x69) && tags.includes(0x2f),
    'qm contains Language, Hashes, Messages and Contexts blocks', tags.join(','));

// The (hash, offset) pairs must be sorted, because Qt binary-searches them.
const hashesStart = (() => {
    let p = 16;
    while (p + 5 <= buffer.length) {
        const tag = buffer.readUInt8(p);
        const length = buffer.readUInt32BE(p + 1);
        if (tag === 0x42) return p + 5;
        p += 5 + length;
    }
    return -1;
})();
let sorted = hashesStart >= 0;
for (let i = 1; i < qm.count && sorted; i++) {
    if (buffer.readUInt32BE(hashesStart + i * 8) < buffer.readUInt32BE(hashesStart + (i - 1) * 8))
        sorted = false;
}
check(sorted, 'qm hash table is sorted for binary search');

if (failures) {
    console.error(`\n${failures} check(s) failed`);
    process.exit(1);
}
console.log('\nAll translation checks passed.');
