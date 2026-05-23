const fs = require('fs');
const path = require('path');

const srcDir = path.join(__dirname, '../src/nodes');
const distDir = path.join(__dirname, '../dist/nodes');

function copySvgs(dir) {
  if (!fs.existsSync(dir)) return;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(dir, entry.name);
    const relPath = path.relative(srcDir, srcPath);
    const distPath = path.join(distDir, relPath);
    if (entry.isDirectory()) {
      fs.mkdirSync(distPath, { recursive: true });
      copySvgs(srcPath);
    } else if (entry.name.endsWith('.svg') || entry.name.endsWith('.png')) {
      fs.copyFileSync(srcPath, distPath);
    }
  }
}

copySvgs(srcDir);
console.log('Assets copied to dist/');
