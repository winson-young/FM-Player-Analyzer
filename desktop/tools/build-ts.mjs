// build-ts.mjs — generate desktop/translations/fmplayeranalyzer_zh_CN.ts.
//
// The application's source strings are German; the Chinese catalogue is
// generated from the hand-maintained translation map in zh-CN-map.mjs so the
// two can never drift apart (every message of the English .ts is emitted, and
// anything missing from the map is written as type="unfinished").
//
// Usage: node tools/build-ts.mjs [--check]
//   --check  do not write; exit 1 if the file on disk differs from the generated one

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ZH } from './zh-CN-map.mjs';
// Reuse the XML end-of-line normalisation (CRLF / lone CR -> LF) of the .qm
// compiler: the catalogue must not depend on how git checked the files out.
import { normaliseNewlines } from './build-qm.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const desktopDir = join(here, '..');
const enTs = join(desktopDir, 'translations', 'fmplayeranalyzer_en.ts');
const outTs = join(desktopDir, 'translations', 'fmplayeranalyzer_zh_CN.ts');

const unescapeXml = (s) => s
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&amp;/g, '&');

// Both escaper forms: text nodes escape <> & only; attributes also need quotes.
const escapeText = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escapeAttr = (s) => escapeText(s).replace(/"/g, '&quot;');

// --- Parse the English catalogue (authoritative list of live tr() strings) ---
const xml = normaliseNewlines(readFileSync(enTs, 'utf8'));
const contexts = [];
for (const cm of xml.matchAll(/<context>([\s\S]*?)<\/context>/g)) {
    const body = cm[1];
    const name = /<name>([\s\S]*?)<\/name>/.exec(body)[1];
    const messages = [];
    for (const mm of body.matchAll(/<message>([\s\S]*?)<\/message>/g)) {
        const messageBody = mm[1];
        const source = /<source>([\s\S]*?)<\/source>/.exec(messageBody);
        if (!source) continue;
        const locations = [...messageBody.matchAll(/<location filename="([^"]*)"(?: line="([^"]*)")?\/>/g)]
            .map((l) => ({ filename: l[1], line: l[2] ?? '' }));
        messages.push({ source: unescapeXml(source[1]), locations });
    }
    if (messages.length) contexts.push({ name, messages });
}
if (!contexts.length) throw new Error(`no contexts found in ${enTs}`);

const total = contexts.reduce((n, c) => n + c.messages.length, 0);

// The map is written by hand, so its keys and translations are normalised too:
// a '\r\n' copied from the German source (or from a CRLF editor) would otherwise
// never match the LF-only source text of the catalogue.
const zhMap = new Map(Object.entries(ZH)
    .map(([key, value]) => [normaliseNewlines(key), typeof value === 'string' ? normaliseNewlines(value) : value]));

// --- Render the Chinese catalogue -------------------------------------------
const lines = [];
lines.push('<?xml version="1.0" encoding="utf-8"?>');
lines.push('<!DOCTYPE TS>');
lines.push('<TS version="2.1" language="zh_CN" sourcelanguage="de">');
const missing = [];
let translated = 0;
for (const context of contexts) {
    lines.push('<context>');
    lines.push(`    <name>${escapeText(context.name)}</name>`);
    for (const message of context.messages) {
        lines.push('    <message>');
        for (const loc of message.locations) {
            const file = relative(desktopDir, join(desktopDir, 'translations', loc.filename)).replace(/\\/g, '/');
            const line = loc.line ? ` line="${escapeAttr(loc.line)}"` : '';
            lines.push(`        <location filename="${escapeAttr(file)}"${line}/>`);
        }
        lines.push(`        <source>${escapeText(message.source)}</source>`);
        const zh = zhMap.get(message.source);
        if (typeof zh === 'string' && zh.length) {
            lines.push(`        <translation>${escapeText(zh)}</translation>`);
            translated++;
        } else {
            lines.push('        <translation type="unfinished"></translation>');
            missing.push(`${context.name}: ${message.source.replace(/\r?\n/g, '\\n').slice(0, 80)}`);
        }
        lines.push('    </message>');
    }
    lines.push('</context>');
}
lines.push('</TS>');
lines.push('');
const output = lines.join('\n');

// Source strings that are mapped but no longer exist in the catalogue.
const live = new Set(contexts.flatMap((c) => c.messages.map((m) => m.source)));
const stale = [...zhMap.keys()].filter((k) => !live.has(k));

const check = process.argv.includes('--check');
if (check) {
    let current = '';
    try { current = readFileSync(outTs, 'utf8'); } catch { /* missing */ }
    // Compare content, not line endings: a Windows checkout with
    // core.autocrlf=true hands us CRLF while the generated file is LF.
    if (normaliseNewlines(current) !== output) {
        console.error(`${outTs} is out of date — run: node tools/build-ts.mjs`);
        process.exit(1);
    }
    console.log(`up to date (${total} messages, ${translated} translated)`);
} else {
    writeFileSync(outTs, output, 'utf8');
    console.log(`wrote ${outTs}: ${total} messages, ${translated} translated, ${missing.length} unfinished`);
}

if (missing.length) {
    console.log(`--- ${missing.length} untranslated (will fall back to German) ---`);
    for (const m of missing) console.log(`  ${m}`);
}
if (stale.length) {
    console.log(`--- ${stale.length} map entries no longer used ---`);
    for (const s of stale) console.log(`  ${s.replace(/\r?\n/g, '\\n').slice(0, 80)}`);
}
if (!check && missing.length) process.exitCode = 2;
