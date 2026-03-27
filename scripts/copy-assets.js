const fs = require('fs');
const path = require('path');

// Copy schema.sql
fs.mkdirSync('dist/db', { recursive: true });
fs.copyFileSync('src/db/schema.sql', 'dist/db/schema.sql');

// Copy tree-sitter wasm files
const wasmSrc = 'src/extraction/wasm';
const wasmDst = 'dist/extraction/wasm';
fs.mkdirSync(wasmDst, { recursive: true });
if (fs.existsSync(wasmSrc)) {
  fs.readdirSync(wasmSrc)
    .filter(f => f.endsWith('.wasm'))
    .forEach(f => fs.copyFileSync(path.join(wasmSrc, f), path.join(wasmDst, f)));
}

console.log('Assets copied.');
