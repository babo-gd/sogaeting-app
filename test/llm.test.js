import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { rankMatches } from '../js/matching.js';
import { defaultMe, generateProfiles } from '../js/profiles.js';
import { callName, buildMatchFacts, sanitizeFacts, factsToText, fallbackExplanation, buildMessages } from '../js/llm.js';
import { createApp } from '../server.js';

const me = { ...defaultMe(), name: '고다은' };
const { matches } = rankMatches(me, generateProfiles());
const facts = buildMatchFacts(me, matches[0], { rank: 0, headline: '가치관이 특히 잘 맞아서 1위예요' });

test('LLM 사실: 호칭과 점수, 잘 맞는/다른 가치관이 알고리즘 결과와 같다', () => {
  assert.equal(callName('김도윤'), '도윤님');
  assert.equal(callName('나'), '회원님');
  assert.equal(facts.me, '다은님');
  assert.equal(facts.total, Math.round(matches[0].total * 100));
  assert.equal(facts.rank, 1);
  assert.ok(facts.agree.length > 0 && facts.agree.length <= 3);
  assert.deepEqual(facts.sharedInterests, matches[0].interests.shared.slice(0, 4));
  const text = factsToText(facts);
  assert.ok(text.includes(`종합 궁합: ${facts.total}점`) && text.includes(facts.them));
  assert.equal(buildMessages(facts)[0].role, 'system');
});

test('LLM 사실 검증: 너무 긴 값은 자르고, 점수는 0~100, 상대 이름이 없으면 거부', () => {
  const s = sanitizeFacts({ ...facts, total: 999, agree: Array(10).fill('가'.repeat(500)), extra: '무시' });
  assert.equal(s.total, 100);
  assert.equal(s.agree.length, 3);
  assert.ok(s.agree[0].length <= 120);
  assert.equal(s.extra, undefined);
  assert.throws(() => sanitizeFacts({ ...facts, them: '' }));
  assert.throws(() => sanitizeFacts(null));
});

test('LLM이 없을 때: 같은 형식의 규칙 기반 설명', () => {
  const text = fallbackExplanation(facts);
  assert.ok(text.startsWith('💡 추천 이유:') && text.includes('💬 이야기해 볼 점:') && text.includes('☕ 첫 대화 주제:'));
  assert.ok(text.includes(`${facts.total}점`));
});

// 가짜 Ollama: /api/tags와 /api/chat(스트리밍)만 흉내 냄
function fakeOllama({ tokens = ['💡 추천 ', '이유: 테스트'], models = ['exaone3.5:2.4b'] } = {}) {
  const seen = [];
  const server = http.createServer(async (req, res) => {
    if (req.url === '/api/tags') return res.end(JSON.stringify({ models: models.map((name) => ({ name })) }));
    let body = '';
    for await (const c of req) body += c;
    seen.push(JSON.parse(body));
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
    for (const t of tokens) res.write(`${JSON.stringify({ message: { content: t }, done: false })}\n`);
    res.end(`${JSON.stringify({ message: { content: '' }, done: true, eval_count: tokens.length })}\n`);
  });
  return new Promise((ok) => server.listen(0, () => ok({ server, url: `http://127.0.0.1:${server.address().port}`, seen })));
}
const listen = (app) => new Promise((ok) => app.listen(0, () => ok(`http://127.0.0.1:${app.address().port}`)));

test('서버 API: 상태 확인과 설명 스트리밍, 프롬프트에 사실이 들어간다', async () => {
  const ollama = await fakeOllama();
  const app = createApp({ ollamaUrl: ollama.url });
  const base = await listen(app);
  try {
    assert.deepEqual(await (await fetch(`${base}/api/llm/status`)).json(), { ok: true, model: 'exaone3.5:2.4b', error: null });

    const r = await fetch(`${base}/api/explain`, { method: 'POST', body: JSON.stringify({ facts }) });
    assert.equal(r.status, 200);
    const lines = (await r.text()).trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(lines.filter((l) => l.t).map((l) => l.t).join(''), '💡 추천 이유: 테스트');
    assert.equal(lines.at(-1).done, true);
    const sent = ollama.seen[0];
    assert.equal(sent.model, 'exaone3.5:2.4b');
    assert.ok(sent.messages[1].content.includes(`종합 궁합: ${facts.total}점`));

    assert.equal((await fetch(`${base}/api/explain`, { method: 'POST', body: '{"facts":{}}' })).status, 400);
    assert.equal((await fetch(`${base}/api/explain`, { method: 'POST', body: 'x'.repeat(20_000) })).status, 413);
    assert.equal((await fetch(`${base}/.git/config`)).status, 404); // 숨김 폴더는 보여주지 않음
  } finally {
    app.close();
    ollama.server.close();
  }
});

test('서버 API: Ollama가 꺼져 있거나 모델이 없으면 알려준다', async () => {
  const off = createApp({ ollamaUrl: 'http://127.0.0.1:9' });
  const base = await listen(off);
  const noModel = await fakeOllama({ models: ['other:latest'] });
  const app2 = createApp({ ollamaUrl: noModel.url });
  const base2 = await listen(app2);
  try {
    const s = await (await fetch(`${base}/api/llm/status`)).json();
    assert.equal(s.ok, false);
    assert.match(s.error, /Ollama/);
    assert.equal((await fetch(`${base}/api/explain`, { method: 'POST', body: JSON.stringify({ facts }) })).status, 502);
    assert.match((await (await fetch(`${base2}/api/llm/status`)).json()).error, /ollama pull/);
  } finally {
    off.close();
    app2.close();
    noModel.server.close();
  }
});
