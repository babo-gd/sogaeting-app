// 의존성 없는 정적 파일 서버: node server.js → http://localhost:5173
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
const port = process.env.PORT || 5173;

http
  .createServer(async (req, res) => {
    const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    const file = resolve(join(root, pathname === '/' ? 'index.html' : pathname));
    if (!file.startsWith(resolve(root) + sep)) return res.writeHead(403).end();
    try {
      const body = await readFile(file);
      res.writeHead(200, {
        'Content-Type': `${types[extname(file)] || 'application/octet-stream'}; charset=utf-8`,
        'Cache-Control': 'no-store', // 개발 중 수정 사항이 바로 반영되도록
      });
      res.end(body);
    } catch {
      res.writeHead(404).end('Not found');
    }
  })
  .listen(port, () => console.log(`http://localhost:${port}`));
