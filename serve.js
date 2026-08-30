// Static server for a WebGL build. Unity needs correct MIME types or the browser
// refuses the wasm; a generic file server will silently serve a broken page.
const http = require('http');
const fs = require('fs');
const path = require('path');

const root = path.resolve(process.argv[2] || '.');
const port = parseInt(process.argv[3] || '8080', 10);

const MIME = {
  '.html': 'text/html', '.js': 'application/javascript', '.json': 'application/json',
  '.wasm': 'application/wasm', '.data': 'application/octet-stream',
  '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.symbols': 'application/octet-stream', '.mem': 'application/octet-stream',
};

http.createServer((req, res) => {
  let rel = decodeURIComponent(req.url.split('?')[0]);
  if (rel === '/') rel = '/index.html';
  const fp = path.join(root, rel);
  if (!fp.startsWith(root)) { res.writeHead(403); return res.end('no'); }

  fs.readFile(fp, (e, buf) => {
    if (e) { res.writeHead(404); return res.end('not found: ' + rel); }
    const ext = path.extname(fp).toLowerCase();
    const h = { 'Content-Type': MIME[ext] || 'application/octet-stream' };
    // Unity's compressed output carries these; harmless when uncompressed.
    if (fp.endsWith('.br')) h['Content-Encoding'] = 'br';
    if (fp.endsWith('.gz')) h['Content-Encoding'] = 'gzip';
    res.writeHead(200, h);
    res.end(buf);
  });
}).listen(port, () => console.log('serving ' + root + '  ->  http://localhost:' + port));
