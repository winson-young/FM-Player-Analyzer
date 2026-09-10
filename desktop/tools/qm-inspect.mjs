// qm-inspect.mjs — read-only inspection of a compiled Qt .qm file.
// Usage: node tools/qm-inspect.mjs <file.qm> [maxMessages]
//
// Decodes the block structure and the context hash table so the binary layout
// produced by lrelease can be verified byte for byte.

import { readFileSync } from 'node:fs';

const MAGIC = Buffer.from([
    0x3c, 0xb8, 0x64, 0x18, 0xca, 0xef, 0x9c, 0x95,
    0xcd, 0x21, 0x1c, 0xbf, 0x60, 0xa1, 0xbd, 0xdd,
]);

const TAG = {
    1: 'End', 2: 'SourceText16', 3: 'Translation', 4: 'Context16',
    5: 'Obsolete1', 6: 'SourceText', 7: 'Context', 8: 'Comment', 9: 'Obsolete2',
};
const BLOCK = {
    0x2f: 'Contexts', 0x42: 'Hashes', 0x69: 'Messages',
    0x88: 'NumerusRules', 0x96: 'Dependencies', 0xa7: 'Language',
};

const file = process.argv[2];
const limit = Number(process.argv[3] ?? 5);
const buf = readFileSync(file);

if (buf.length < 16 || !buf.subarray(0, 16).equals(MAGIC)) {
    console.error('not a .qm file (magic mismatch)');
    process.exit(1);
}
console.log(`file=${file} size=${buf.length}`);

let pos = 16;
const blocks = [];
while (pos + 5 <= buf.length) {
    const tag = buf.readUInt8(pos);
    const len = buf.readUInt32BE(pos + 1);
    if (!tag || !len) break;
    blocks.push({ tag, name: BLOCK[tag] ?? `0x${tag.toString(16)}`, start: pos + 5, len });
    pos += 5 + len;
}
for (const b of blocks) console.log(`block ${b.name} len=${b.len} @${b.start}`);

const byName = Object.fromEntries(blocks.map((b) => [b.name, b]));

if (byName.Language) {
    console.log(`language=${buf.toString('utf8', byName.Language.start, byName.Language.start + byName.Language.len)}`);
}

// --- Hashes ---------------------------------------------------------------
const offs = [];
if (byName.Hashes) {
    const n = byName.Hashes.len / 8;
    for (let i = 0; i < n; i++) {
        offs.push({
            h: buf.readUInt32BE(byName.Hashes.start + i * 8),
            o: buf.readUInt32BE(byName.Hashes.start + i * 8 + 4),
        });
    }
    console.log(`offsets=${n}`);
}

// --- Context hash table ---------------------------------------------------
if (byName.Contexts) {
    const c = byName.Contexts.start;
    const hTableSize = buf.readUInt16BE(c);
    const poolBase = c + 2 + hTableSize * 2;
    console.log(`contexts: hTableSize=${hTableSize}`);
    const nonZero = [];
    for (let i = 0; i < hTableSize; i++) {
        const v = buf.readUInt16BE(c + 2 + i * 2);
        if (v) nonZero.push([i, v]);
    }
    console.log(`contexts: non-zero buckets=${nonZero.length}`);
    console.log(`contexts: poolBase(after table)=${poolBase - byName.Contexts.start} rel, file offset ${poolBase}`);
    for (const [i, v] of nonZero.slice(0, 3)) {
        for (const conv of [
            ['off*2', v * 2],
            ['off*2+1', v * 2 + 1],
            ['(off-1)*2+2', (v - 1) * 2 + 2],
        ]) {
            const p = poolBase + conv[1];
            const len = buf.readUInt8(p);
            const text = buf.toString('utf8', p + 1, p + 1 + len);
            console.log(`  bucket ${i} val=${v} ${conv[0]} -> rel=${conv[1]} len=${len} text=${JSON.stringify(text)}`);
        }
    }
    // Dump raw pool head for eyeballing.
    console.log(`contexts: pool head = ${buf.subarray(poolBase, poolBase + 24).toString('hex')}`);
}

// --- Messages -------------------------------------------------------------
function readMessage(start, ctxPool) {
    let p = start;
    const out = { translations: [], source: null, context: null, comment: null };
    for (;;) {
        const tag = buf.readUInt8(p++);
        switch (tag) {
            case 1: return out;
            case 3: {
                const len = buf.readInt32BE(p); p += 4;
                if (len === -1) { out.translations.push(null); break; }
                let s = '';
                for (let i = 0; i < len; i += 2) s += buf.readUInt16BE(p + i);
                p += len;
                out.translations.push(s);
                break;
            }
            case 5: p += 4; break;
            case 6: {
                const len = buf.readUInt32BE(p); p += 4;
                out.source = buf.toString('utf8', p, p + len); p += len; break;
            }
            case 7: {
                const len = buf.readUInt32BE(p); p += 4;
                out.context = buf.toString('utf8', p, p + len); p += len; break;
            }
            case 8: {
                const len = buf.readUInt32BE(p); p += 4;
                out.comment = buf.toString('utf8', p, p + len); p += len; break;
            }
            default: throw new Error(`unknown tag ${tag} at ${p - 1} (ctxPool=${ctxPool})`);
        }
    }
}

if (byName.Messages && offs.length) {
    console.log('--- first messages ---');
    for (const { h, o } of offs.slice(0, limit)) {
        const m = readMessage(byName.Messages.start + o);
        console.log(`h=${h} o=${o} ctx=${JSON.stringify(m.context)} src=${JSON.stringify(m.source)} tln=${JSON.stringify(m.translations)}`);
        if (m.source !== null) {
            // verify the hash covers sourceText (+comment)
            let hh = 0;
            const bytes = Buffer.from((m.source ?? '') + (m.comment ?? ''), 'utf8');
            for (const byte of bytes) {
                hh = (hh << 4) + byte;
                const g = hh & 0xf0000000;
                if (g) hh ^= g >>> 24;
                hh &= ~g;
            }
            if (!hh) hh = 1;
            console.log(`   hash check: computed=${hh >>> 0} stored=${h} ${(hh >>> 0) === h ? 'OK' : 'MISMATCH'}`);
        }
    }
}
