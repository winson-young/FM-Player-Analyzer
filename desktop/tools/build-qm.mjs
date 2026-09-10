// build-qm.mjs — compile a Qt .ts catalogue into a binary .qm translation file.
//
// The repository's build machines have Qt (lrelease) available, but the format
// is fully specified by Qt itself, so this compiler keeps the pipeline working
// on machines without a Qt installation and gives the catalogue a deterministic
// output that CI can diff. The binary layout implemented here follows
// qtbase/src/corelib/kernel/qtranslator.cpp (the reader) and
// qttools/src/linguist/shared/qm.cpp (the writer):
//
//   magic[16]
//   block: uint8 tag, uint32 length, length bytes   (repeated)
//     tag 0x42 Hashes      -> { uint32 hash, uint32 messageOffset } * n, sorted
//     tag 0x69 Messages    -> concatenated message records, offsets above point here
//     tag 0x2f Contexts    -> uint16 tableSize, uint16 table[tableSize], pool
//     tag 0xa7 Language    -> the language code, UTF-8
//   message record: (uint8 tag, payload)*, uint8 1
//     tag 3 Translation  -> uint32 (UTF-16 code units, even) + big-endian UTF-16
//     tag 8 Comment      -> uint32 length + UTF-8
//     tag 6 SourceText   -> uint32 length + UTF-8
//     tag 7 Context      -> uint32 length + UTF-8
//
// A message's hash is elfHash(sourceText + comment), and the context hash table
// stores poolOffset >> 1 (the pool starts with a 2-byte zero entry at offset 0).
//
// Usage: node tools/build-qm.mjs <in.ts> <out.qm> [--verify]

import { readFileSync, writeFileSync } from 'node:fs';

const MAGIC = Buffer.from([
    0x3c, 0xb8, 0x64, 0x18, 0xca, 0xef, 0x9c, 0x95,
    0xcd, 0x21, 0x1c, 0xbf, 0x60, 0xa1, 0xbd, 0xdd,
]);
const TAG = {
    End: 1, SourceText16: 2, Translation: 3, Context16: 4,
    Obsolete1: 5, SourceText: 6, Context: 7, Comment: 8, Obsolete2: 9,
};
const BLOCK = { Contexts: 0x2f, Hashes: 0x42, Messages: 0x69, NumerusRules: 0x88, Dependencies: 0x96, Language: 0xa7 };

const ENTITIES = { lt: '<', gt: '>', quot: '"', apos: "'", amp: '&' };
const unescapeXml = (s) => s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body) => {
    if (body[0] === '#') {
        const code = body[1] === 'x' || body[1] === 'X'
            ? Number.parseInt(body.slice(2), 16)
            : Number.parseInt(body.slice(1), 10);
        return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[body] ?? whole;
});

// --- elfHash, exactly as Qt computes it over the UTF-8 source(+comment) bytes --
export function elfHash(text) {
    let h = 0;
    for (const byte of Buffer.from(text, 'utf8')) {
        h = (h << 4) + byte;
        const g = h & 0xf0000000;
        if (g) h ^= g >>> 24;
        h &= ~g;
    }
    return h >>> 0 || 1; // elfHash_finish(): a zero hash becomes 1
}

export function parseTs(xml) {
    // lupdate writes UTF-8 without a BOM, but accepting one costs nothing and
    // avoids a confusing parse failure on hand-edited files.
    const text = xml.charCodeAt(0) === 0xfeff ? xml.slice(1) : xml;
    const messages = [];
    for (const cm of text.matchAll(/<context>([\s\S]*?)<\/context>/g)) {
        const body = cm[1];
        const context = unescapeXml(/<name>([\s\S]*?)<\/name>/.exec(body)[1]);
        for (const mm of body.matchAll(/<message>([\s\S]*?)<\/message>/g)) {
            const messageBody = mm[1];
            const sourceMatch = /<source>([\s\S]*?)<\/source>/.exec(messageBody);
            if (!sourceMatch) continue;
            const translationMatch = /<translation([^>]*)>([\s\S]*?)<\/translation>/.exec(messageBody);
            if (!translationMatch) continue;
            const attrs = translationMatch[1] ?? '';
            const type = /type="([^"]*)"/.exec(attrs)?.[1] ?? 'finished';
            const commentMatch = /<comment>([\s\S]*?)<\/comment>/.exec(messageBody);
            messages.push({
                context,
                source: unescapeXml(sourceMatch[1]),
                translation: type === 'unfinished' || type === 'obsolete' || type === 'vanished'
                    ? null
                    : unescapeXml(translationMatch[2]),
                comment: commentMatch ? unescapeXml(commentMatch[1]) : '',
                type,
            });
        }
    }
    return messages;
}

const u8 = (n) => Buffer.from([n & 0xff]);
const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16BE(n & 0xffff); return b; };
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0); return b; };
const utf8 = (s) => Buffer.from(s, 'utf8');
const lenPrefixed = (s) => { const bytes = utf8(s); return Buffer.concat([u32(bytes.length), bytes]); };
const translationBytes = (s) => {
    // QDataStream << QString for a non-null string: uint32 byte length, then
    // UTF-16 big-endian code units (length is therefore always even).
    const b = Buffer.alloc(s.length * 2);
    for (let i = 0; i < s.length; i++) b.writeUInt16BE(s.charCodeAt(i), i * 2);
    return Buffer.concat([u32(b.length), b]);
};

export function compileQm(messages, language) {
    // Only transcribed messages are written; unfinished ones stay untranslated
    // so Qt falls back to the German source text.
    const usable = messages
        .filter((m) => typeof m.translation === 'string' && m.translation.length > 0)
        .map((m) => ({ ...m, hash: elfHash(m.source + m.comment) }))
        .sort((a, b) => (a.hash !== b.hash ? a.hash - b.hash : 0));

    // --- Messages, while recording each record's offset -----------------------
    const records = [];
    const offsetArray = [];
    let position = 0;
    for (const message of usable) {
        const parts = [u8(TAG.Translation), translationBytes(message.translation)];
        if (message.comment) parts.push(u8(TAG.Comment), lenPrefixed(message.comment));
        parts.push(u8(TAG.SourceText), lenPrefixed(message.source));
        parts.push(u8(TAG.Context), lenPrefixed(message.context));
        parts.push(u8(TAG.End));
        const record = Buffer.concat(parts);
        offsetArray.push({ hash: message.hash, offset: position });
        records.push(record);
        position += record.length;
    }
    const messagesBlock = Buffer.concat(records);

    // Qt locates a candidate by binary-searching the (hash, offset) pairs, so
    // they must be sorted by hash and then offset.
    offsetArray.sort((a, b) => (a.hash !== b.hash ? a.hash - b.hash : a.offset - b.offset));
    const hashesBlock = Buffer.concat(
        offsetArray.flatMap((e) => [u32(e.hash), u32(e.offset)]));

    // --- Context hash table ---------------------------------------------------
    const contextNames = [...new Set(usable.map((m) => m.context))].sort();
    const tableSize = chooseContextTableSize(contextNames.length);
    const buckets = new Map();
    for (const name of contextNames) {
        const bucket = elfHash(name) % tableSize;
        if (!buckets.has(bucket)) buckets.set(bucket, []);
        buckets.get(bucket).push(name);
    }

    // The pool starts with a two-byte zero entry that can never be addressed
    // (offset 0 -> "empty string"); entries then start at offset 2, and the hash
    // table stores poolOffset >> 1.
    const pool = [u16(0)];
    const table = new Array(tableSize).fill(0);
    let poolOffset = 2;
    for (const bucket of [...buckets.keys()].sort((a, b) => a - b)) {
        table[bucket] = poolOffset >> 1;
        for (const name of buckets.get(bucket)) {
            const bytes = utf8(name).subarray(0, 255);
            pool.push(u8(bytes.length), bytes);
            poolOffset += 1 + bytes.length;
        }
        if (poolOffset & 1) { // offsets must stay even
            pool.push(u8(0));
            poolOffset += 1;
        }
    }
    const contextsBlock = Buffer.concat([u16(tableSize), ...table.map(u16), ...pool]);

    const blocks = [
        [BLOCK.Language, utf8(language)],
        [BLOCK.Hashes, hashesBlock],
        [BLOCK.Messages, messagesBlock],
        [BLOCK.Contexts, contextsBlock],
    ];
    const body = blocks
        .filter(([, data]) => data.length)
        .flatMap(([tag, data]) => [u8(tag), u32(data.length), data]);
    return {
        buffer: Buffer.concat([MAGIC, ...body]),
        stats: {
            messages: usable.length,
            skipped: messages.length - usable.length,
            contexts: contextNames.length,
            tableSize,
            bytes: MAGIC.length + body.reduce((n, part) => n + part.length, 0),
        },
    };
}

// Mirrors Releaser::squeeze() in qm.cpp.
function chooseContextTableSize(contextCount) {
    if (contextCount < 200) return contextCount < 60 ? 151 : 503;
    if (contextCount < 2500) return contextCount < 750 ? 1511 : 5003;
    return contextCount < 10000 ? 15013 : (3 * contextCount) >> 1;
}

// --- reader, mirroring QTranslatorPrivate::do_translate() --------------------
function readContextTable(buffer, start, length) {
    const tableSize = buffer.readUInt16BE(start);
    const poolBase = start + 2 + tableSize * 2;
    return {
        lookup(context) {
            const bucket = elfHash(context) % tableSize;
            const off = buffer.readUInt16BE(start + 2 + bucket * 2);
            if (off === 0) return null;
            let p = poolBase + (off << 1);
            for (;;) {
                const len = buffer.readUInt8(p++);
                if (len === 0) return null;
                const text = buffer.toString('utf8', p, p + len);
                if (text === context) return context;
                p += len;
            }
        },
    };
}

export function decodeQm(buffer) {
    if (buffer.length < 16 || !buffer.subarray(0, 16).equals(MAGIC))
        throw new Error('bad magic');
    const blocks = {};
    let pos = 16;
    while (pos + 5 <= buffer.length) {
        const tag = buffer.readUInt8(pos);
        const length = buffer.readUInt32BE(pos + 1);
        if (!tag || !length) break;
        blocks[tag] = { start: pos + 5, length };
        pos += 5 + length;
    }
    if (!blocks[BLOCK.Messages] || !blocks[BLOCK.Hashes]) throw new Error('missing messages/hashes');

    const contexts = blocks[BLOCK.Contexts]
        ? readContextTable(buffer, blocks[BLOCK.Contexts].start, blocks[BLOCK.Contexts].length)
        : { lookup: () => '' };

    const messages = blocks[BLOCK.Messages];
    const readMessage = (offset, context, source, comment) => {
        let p = messages.start + offset;
        const end = messages.start + messages.length;
        let translation = null;
        while (p < end) {
            const tag = buffer.readUInt8(p++);
            if (tag === TAG.End) break;
            if (tag === TAG.Translation) {
                const len = buffer.readUInt32BE(p); p += 4;
                if (len & 1) return null;
                let text = '';
                for (let i = 0; i < len; i += 2) text += String.fromCharCode(buffer.readUInt16BE(p + i));
                p += len;
                if (translation === null) translation = text; // numerus index 0
            } else if (tag === TAG.SourceText) {
                const len = buffer.readUInt32BE(p); p += 4;
                const text = buffer.toString('utf8', p, p + len); p += len;
                // Qt's match() ignores a trailing NUL that lrelease may include.
                if (text.replace(/\0$/, '') !== source) return null;
            } else if (tag === TAG.Context) {
                const len = buffer.readUInt32BE(p); p += 4;
                const text = buffer.toString('utf8', p, p + len); p += len;
                if (text !== context) return null;
            } else if (tag === TAG.Comment) {
                const len = buffer.readUInt32BE(p); p += 4;
                const text = buffer.toString('utf8', p, p + len); p += len;
                if (text && text !== comment) return null;
            } else {
                return null;
            }
        }
        return translation;
    };

    const count = blocks[BLOCK.Hashes].length / 8;
    return {
        language: blocks[BLOCK.Language]
            ? buffer.toString('utf8', blocks[BLOCK.Language].start,
                blocks[BLOCK.Language].start + blocks[BLOCK.Language].length)
            : '',
        count,
        translate(context, source, comment = '') {
            if (contexts.lookup(context) === null) return null;
            const hash = elfHash(source + comment);
            // Binary search, then walk back over equal hashes (Qt's algorithm).
            let lo = 0, hi = count - 1, found = -1;
            while (lo <= hi) {
                const mid = (lo + hi) >> 1;
                const h = buffer.readUInt32BE(blocks[BLOCK.Hashes].start + mid * 8);
                if (h === hash) { found = mid; break; }
                if (h < hash) lo = mid + 1; else hi = mid - 1;
            }
            if (found < 0) return null;
            let i = found;
            while (i > 0 && buffer.readUInt32BE(blocks[BLOCK.Hashes].start + (i - 1) * 8) === hash) i--;
            for (; i < count; i++) {
                const base = blocks[BLOCK.Hashes].start + i * 8;
                if (buffer.readUInt32BE(base) !== hash) break;
                const result = readMessage(buffer.readUInt32BE(base + 4), context, source, comment);
                if (result !== null) return result;
            }
            return null;
        },
    };
}

// --- CLI --------------------------------------------------------------------
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const invokedDirectly = (() => {
    if (!process.argv[1]) return false;
    try {
        return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
    } catch {
        return false;
    }
})();
if (invokedDirectly) {
    const input = process.argv[2];
    const output = process.argv[3];
    const verify = process.argv.includes('--verify');
    if (!input || !output) {
        console.error('usage: node tools/build-qm.mjs <in.ts> <out.qm> [--verify]');
        process.exit(2);
    }
    const xml = readFileSync(input, 'utf8');
    const messages = parseTs(xml);
    const language = /<TS[^>]*\blanguage="([^"]*)"/.exec(xml)?.[1] ?? '';
    const { buffer, stats } = compileQm(messages, language);
    writeFileSync(output, buffer);
    console.log(`wrote ${output}: ${stats.messages} messages (${stats.skipped} untranslated skipped), `
        + `${stats.contexts} contexts, ${stats.bytes} bytes`);

    if (verify) {
        const qm = decodeQm(buffer);
        let checked = 0, failed = 0;
        for (const message of messages) {
            if (typeof message.translation !== 'string' || !message.translation.length) continue;
            checked++;
            const got = qm.translate(message.context, message.source, message.comment);
            if (got !== message.translation) {
                failed++;
                if (failed <= 5) {
                    console.error(`  MISMATCH [${message.context}] ${JSON.stringify(message.source)}\n`
                        + `    expected ${JSON.stringify(message.translation)}\n    got      ${JSON.stringify(got)}`);
                }
            }
        }
        // A lookup that must not resolve, to prove the context table rejects
        // unknown contexts and unknown source strings.
        const negative = [
            ['fm::DoesNotExist', messages[0].source],
            [messages[0].context, 'Dieser String existiert nicht'],
        ].filter(([ctx, src]) => qm.translate(ctx, src) !== null).length;
        console.log(`verify: ${checked - failed}/${checked} lookups OK, ${negative} unexpected hit(s)`);
        if (failed || negative) process.exit(1);
    }
}
