'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const ROOT = path.resolve(__dirname, '..');
const CRATE = path.join(ROOT, 'rust', 'geometry-kernel');
const ARTIFACT = path.join(ROOT, 'media', 'geometry-kernel.js');
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function sourceHash() {
    const hash = crypto.createHash('sha256');
    const sources = [];
    const collect = directory => {
        for (const entry of fs.readdirSync(path.join(CRATE, directory), { withFileTypes: true })) {
            const file = directory + '/' + entry.name;
            if (entry.isDirectory()) collect(file);
            else if (entry.isFile() && file.endsWith('.rs')) sources.push(file);
        }
    };
    collect('src');
    for (const file of ['Cargo.toml', 'Cargo.lock', 'rust-toolchain.toml', ...sources.sort()]) {
        // Canonical text lets an unchanged checkout verify with CRLF on Windows.
        hash.update(file + '\0');
        hash.update(fs.readFileSync(path.join(CRATE, file), 'utf8').replace(/\r\n/g, '\n'));
        hash.update('\0');
    }
    return hash.digest('hex');
}

function verifyArtifact() {
    const artifact = require(ARTIFACT);
    const bytes = Buffer.from(artifact.base64, 'base64');
    if (artifact.sourceSha256 !== sourceHash() || artifact.wasmSha256 !== sha256(bytes) || !WebAssembly.validate(bytes)) {
        throw new Error('Rust geometry artifact is stale or invalid. Run npm run build:rust.');
    }
    return artifact;
}

module.exports = { CRATE, ARTIFACT, sha256, sourceHash, verifyArtifact };
