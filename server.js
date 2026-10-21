// 의존성 없는 서버: 정적 파일 + 로컬 LLM(Ollama) 매칭 API
//   node server.js → http://localhost:5173
//   환경 변수: PORT, OLLAMA_URL(기본 http://127.0.0.1:11434), OLLAMA_MODEL(기본 exaone3.5:2.4b)
//
//   POST /api/ai-match      나와 후보들의 특징 → LLM이 가장 잘 맞는 상대를 골라 이유와 함께 돌려줌
//   POST /api/match-explain  매칭된 두 사람의 특징 → LLM이 왜 매칭됐는지 설명 (한 글자씩 흘려 보냄)
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_MODEL } from './js/llm.js';
import {
  sanitizePickRequest, buildPickMessages, pickSchema, parsePicks,
  sanitizeExplainRequest, buildExplainMessages,
} from './js/aimatch.js';

const root = fileURLToPath(new URL('.', import.meta.url));
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
const MAX_BODY = 32 * 1024;

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

// 요청 본문을 읽고 검증. 실패하면 400/413을 보내고 null
async function parseRequest(req, res, sanitize) {
  try {
    return sanitize(JSON.parse(await readBody(req)));
  } catch (e) {
    json(res, e.status ?? 400, { error: e.status ? e.message : `잘못된 요청이에요: ${e.message}` });
    return null;
  }
}

// Ollama의 스트리밍 답(한 줄에 JSON 하나)을 한 조각씩 넘겨줌
async function* ollamaStream(body) {
  const decoder = new TextDecoder();
  let buf = '';
  for await (const chunk of body) {
    buf += decoder.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      if (msg.error) throw new Error(msg.error);
      yield msg;
    }
  }
}

export function createApp({ ollamaUrl = process.env.OLLAMA_URL || 'http://127.0.0.1:11434', model = process.env.OLLAMA_MODEL || DEFAULT_MODEL } = {}) {
  let warmed = false;

  // Ollama가 켜져 있고 모델이 설치돼 있는지. 처음 확인할 때 모델을 미리 메모리에 올려 둠
  async function status(res) {
    try {
      const r = await fetch(`${ollamaUrl}/api/tags`, { signal: AbortSignal.timeout(2500) });
      const names = (await r.json()).models?.map((m) => m.name) ?? [];
      const ok = names.includes(model);
      if (ok && !warmed) {
        warmed = true;
        fetch(`${ollamaUrl}/api/generate`, { method: 'POST', body: JSON.stringify({ model, keep_alive: '30m' }) }).catch(() => (warmed = false));
      }
      json(res, 200, { ok, model, error: ok ? null : `${model} 모델이 설치되어 있지 않아요 (ollama pull ${model})` });
    } catch {
      json(res, 200, { ok: false, model, error: 'Ollama에 연결할 수 없어요. Ollama를 실행해 주세요.' });
    }
  }

  // Ollama에 대화 요청. 연결 실패면 502를 보내고 null
  async function askOllama(req, res, payload) {
    const abort = new AbortController();
    res.on('close', () => abort.abort()); // 사용자가 화면을 떠나거나 멈추면 생성도 멈춤
    try {
      const upstream = await fetch(`${ollamaUrl}/api/chat`, {
        method: 'POST',
        signal: abort.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, stream: true, keep_alive: '30m', ...payload }),
      });
      if (!upstream.ok) throw new Error(`Ollama 응답 ${upstream.status}`);
      return { upstream, abort };
    } catch (e) {
      if (!abort.signal.aborted) json(res, 502, { error: `로컬 LLM에 연결하지 못했어요: ${e.message}` });
      return null;
    }
  }

  const startStream = (res) => {
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store' });
    return (obj) => res.write(`${JSON.stringify(obj)}\n`);
  };

  // LLM 매칭: {phase:'read'} → {phase:'write', n} … → {done, picks:[{id, reason}], ms}
  async function aiMatch(req, res) {
    const input = await parseRequest(req, res, sanitizePickRequest);
    if (!input) return;
    const conn = await askOllama(req, res, {
      // 고르는 일은 일관되게: 온도를 낮추고, 답은 후보 기호만 고를 수 있는 JSON 형식으로 제한
      format: pickSchema(input.candidates, input.pick),
      options: { temperature: 0.2, num_ctx: 4096, num_predict: 120 * input.pick },
      messages: buildPickMessages(input),
    });
    if (!conn) return;

    const send = startStream(res);
    send({ phase: 'read', model, candidates: input.candidates.length });
    const started = Date.now();
    let text = '';
    try {
      for await (const msg of ollamaStream(conn.upstream.body)) {
        if (msg.message?.content) {
          if (!text) send({ phase: 'write', ms: Date.now() - started });
          text += msg.message.content;
        }
        if (msg.done) {
          const picks = parsePicks(text, input.candidates, input.pick, input.meName);
          send({ done: true, picks, model, ms: Date.now() - started, tokens: msg.eval_count ?? null });
        }
      }
    } catch (e) {
      if (!conn.abort.signal.aborted) send({ error: `AI가 상대를 고르는 중 문제가 생겼어요: ${e.message}` });
    }
    res.end();
  }

  // 매칭 설명: {t: 글자} … {done: true}
  async function matchExplain(req, res) {
    const input = await parseRequest(req, res, sanitizeExplainRequest);
    if (!input) return;
    const conn = await askOllama(req, res, {
      options: { temperature: 0.3, num_ctx: 4096, num_predict: 360 },
      messages: buildExplainMessages(input),
    });
    if (!conn) return;

    const send = startStream(res);
    const started = Date.now();
    try {
      for await (const msg of ollamaStream(conn.upstream.body)) {
        if (msg.message?.content) send({ t: msg.message.content });
        if (msg.done) send({ done: true, model, ms: Date.now() - started, tokens: msg.eval_count ?? null });
      }
    } catch (e) {
      if (!conn.abort.signal.aborted) send({ error: `설명을 만드는 중 문제가 생겼어요: ${e.message}` });
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
    if (pathname === '/api/ai-match' && req.method === 'POST') return aiMatch(req, res);
    if (pathname === '/api/match-explain' && req.method === 'POST') return matchExplain(req, res);
    if (pathname.startsWith('/api/')) return json(res, 404, { error: '없는 API예요' });
    return serveFile(req, res);
  });
}

// node server.js로 직접 실행할 때만 서버를 띄움 (테스트에서는 createApp만 가져다 씀)
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = process.env.PORT || 5173;
  createApp().listen(port, () => console.log(`가치관 소개팅 + 로컬 LLM 매칭: http://localhost:${port}`));
}
