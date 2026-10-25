const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

// Shared HTTP cache contract: v = first 16 lowercase hex digits of SHA-256(bytes).
const contentHash = bytes => createHash('sha256').update(bytes).digest('hex').slice(0, 16);

function buildWeb(root = path.resolve(__dirname, '..')) {
  const source = path.join(root, 'web');
  const output = path.join(root, 'dist/web');
  fs.mkdirSync(path.join(output, 'vendor'), { recursive: true });
  for (const name of ['style.css', 'manifest.webmanifest', 'icons', 'sounds']) {
    // Remove stale copied assets without touching the compiler's app.js output.
    fs.rmSync(path.join(output, name), { recursive: true, force: true });
    fs.cpSync(path.join(source, name), path.join(output, name), { recursive: true });
  }
  fs.copyFileSync(path.join(root, 'node_modules/artplayer/dist/artplayer.mjs'), path.join(output, 'vendor/artplayer-5.4.0.mjs'));
  fs.copyFileSync(path.join(source, 'third-party/artplayer-LICENSE.txt'), path.join(output, 'vendor/artplayer-LICENSE.txt'));

  const resources = ['app.js', 'style.css'].map(name => {
    const hash = contentHash(fs.readFileSync(path.join(output, name)));
    return { url: `/${name}?v=${hash}`, hash };
  });
  let html = fs.readFileSync(path.join(source, 'index.html'), 'utf8');
  for (const entry of resources) {
    const pathname = entry.url.split('?')[0];
    const attribute = pathname === '/app.js' ? 'src' : 'href';
    const reference = `${attribute}="${pathname}"`;
    if (html.split(reference).length !== 2) throw new Error(`Expected one ${reference} in index.html`);
    html = html.replace(reference, `${attribute}="${entry.url}"`);
  }
  fs.writeFileSync(path.join(output, 'index.html'), html);

  // Only explicitly shipped public assets belong here. No directory-prefix matching in SW.
  const icons = fs.readdirSync(path.join(output, 'icons')).sort()
    .filter(name => /\.(svg|png|ico)$/.test(name))
    .map(name => `icons/${name}`);
  for (const name of ['index.html', 'manifest.webmanifest', ...icons]) {
    resources.push({ url: `/${name}`, hash: contentHash(fs.readFileSync(path.join(output, name))) });
  }
  const template = fs.readFileSync(path.join(source, 'sw.js'), 'utf8');
  const version = contentHash(JSON.stringify(resources) + template);
  const marker = 'null /* BUILD_MANIFEST */';
  if (template.split(marker).length !== 2) throw new Error('Expected one SW build manifest marker');
  fs.writeFileSync(path.join(output, 'sw.js'), template.replace(marker, JSON.stringify({ version, resources })));
  return { version, resources };
}

module.exports = { buildWeb, contentHash };
if (require.main === module) buildWeb();
