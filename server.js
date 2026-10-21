// 의존성 없는 서버: 정적 파일 + 로컬 LLM(Ollama) 매칭 설명 API
//   node server.js → http://localhost:5173
//   환경 변수: PORT, OLLAMA_URL(기본 http://127.0.0.1:11434), OLLAMA_MODEL(기본 exaone3.5:2.4b)
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_MODEL, sanitizeFacts, buildMessages } from './js/llm.js';

const root = fileURLToPath(new URL('.', import.meta.url));
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
const MAX_BODY = 16 * 1024;

const json = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
};

function readBody(req) {
  return new Promise((ok, fail) => {
    let size = 0;
    const chunks = [];
    const onData = (c) => {
      size += c.length;
      if (size <= MAX_BODY) return chunks.push(c);
      // 연결을 바로 끊으면 413 응답을 못 받으므로, 나머지는 읽고 버림
      req.off('data', onData);
      req.resume();
      fail(Object.assign(new Error('요청이 너무 커요'), { status: 413 }));
    };
    req.on('data', onData);
    req.on('end', () => ok(Buffer.concat(chunks).toString('utf8')));
    req.on('error', fail);
  });
}

export function createApp({ ollamaUrl = process.env.OLLAMA_URL || 'http://127.0.0.1:11434', model = process.env.OLLAMA_MODEL || DEFAULT_MODEL } = {}) {
  // Ollama가 켜져 있고 모델이 설치돼 있는지
  async function status(res) {
    try {
      const r = await fetch(`${ollamaUrl}/api/tags`, { signal: AbortSignal.timeout(2500) });
      const names = (await r.json()).models?.map((m) => m.name) ?? [];
      const ok = names.includes(model);
      json(res, 200, { ok, model, error: ok ? null : `${model} 모델이 설치되어 있지 않아요 (ollama pull ${model})` });
    } catch {
      json(res, 200, { ok: false, model, error: 'Ollama에 연결할 수 없어요. Ollama를 실행해 주세요.' });
    }
  }

  // 매칭 설명 생성: 결과를 한 줄씩 JSON으로 흘려 보냄 {t: 글자} … {done: true}
  async function explain(req, res) {
    let facts;
    try {
      facts = sanitizeFacts(JSON.parse(await readBody(req)).facts);
    } catch (e) {
      return json(res, e.status ?? 400, { error: e.status ? e.message : `잘못된 요청이에요: ${e.message}` });
    }

    const abort = new AbortController();
    res.on('close', () => abort.abort()); // 사용자가 화면을 떠나면 생성도 멈춤
    let upstream;
    try {
      upstream = await fetch(`${ollamaUrl}/api/chat`, {
        method: 'POST',
        signal: abort.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          stream: true,
          keep_alive: '30m',
          options: { temperature: 0.3, num_predict: 320 },
          messages: buildMessages(facts),
        }),
      });
      if (!upstream.ok) throw new Error(`Ollama 응답 ${upstream.status}`);
    } catch (e) {
      if (abort.signal.aborted) return;
      return json(res, 502, { error: `로컬 LLM에 연결하지 못했어요: ${e.message}` });
    }

    res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store' });
    const send = (obj) => res.write(`${JSON.stringify(obj)}\n`);
    const started = Date.now();
    const decoder = new TextDecoder();
    let buf = '';
    try {
      for await (const chunk of upstream.body) {
        buf += decoder.decode(chunk, { stream: true });
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (!line) continue;
          const msg = JSON.parse(line);
          if (msg.error) throw new Error(msg.error);
          if (msg.message?.content) send({ t: msg.message.content });
          if (msg.done) send({ done: true, model, ms: Date.now() - started, tokens: msg.eval_count ?? null });
        }
      }
    } catch (e) {
      if (!abort.signal.aborted) send({ error: `설명을 만드는 중 문제가 생겼어요: ${e.message}` });
    }
    res.end();
  }

  async function serveFile(req, res) {
    const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    // .git, .claude 같은 숨김 폴더·파일은 보여주지 않음
    if (pathname.split('/').some((seg) => seg.startsWith('.'))) return res.writeHead(404).end('Not found');
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
  }

  return http.createServer((req, res) => {
    const { pathname } = new URL(req.url, 'http://localhost');
    if (pathname === '/api/llm/status' && req.method === 'GET') return status(res);
    if (pathname === '/api/explain' && req.method === 'POST') return explain(req, res);
    if (pathname.startsWith('/api/')) return json(res, 404, { error: '없는 API예요' });
    return serveFile(req, res);
  });
}

// node server.js로 직접 실행할 때만 서버를 띄움 (테스트에서는 createApp만 가져다 씀)
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = process.env.PORT || 5173;
  createApp().listen(port, () => console.log(`http://localhost:${port}`));
}
