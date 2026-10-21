import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { rankMatches } from '../js/matching.js';
import { defaultMe, generateProfiles } from '../js/profiles.js';
import { callName } from '../js/llm.js';
import {
  aiCandidates, traitsOf, myTraits, splitGroups, sanitizePickRequest, buildPickMessages, pickSchema, parsePicks, tidyReason,
  fallbackPicks, explainFacts, sanitizeExplainRequest, buildExplainMessages, fallbackMatchExplanation, BATCH_SIZE,
} from '../js/aimatch.js';
import { createApp } from '../server.js';

const me = { ...defaultMe(), name: '고다은' };
const pool = generateProfiles();
const cands = aiCandidates(me, pool);
const pickBody = { me: myTraits(me), meName: callName(me.name), candidates: cands.map((c) => ({ text: traitsOf(c.profile, { distance: c.distance, me }) })), pick: 3 };

test('후보: 서로의 반드시 조건을 통과한 이성만, 추천 점수 순서와 상관없이 섞음', () => {
  const { matches } = rankMatches(me, pool);
  assert.equal(cands.length, matches.length);
  assert.deepEqual(new Set(cands.map((c) => c.profile.id)), new Set(matches.map((m) => m.profile.id)));
  assert.ok(cands.every((c) => c.profile.gender !== me.gender));
  assert.notDeepEqual(cands.map((c) => c.profile.id), matches.map((m) => m.profile.id));
});

test('특징 리스트업: 호칭·관심사·가치관·같은 답이 글로 들어가고, 자기소개는 직접 쓴 것만', () => {
  const t = traitsOf(cands[0].profile, { label: 'A', distance: cands[0].distance, me });
  assert.match(t, /^\[A\] .+님 · 남 \d+세/);
  assert.ok(t.includes('관심사:') && t.includes('결혼 생각=') && t.includes('나와 같은 답:'));
  assert.ok(!t.includes('자기소개'), '샘플 회원의 자동 소개는 고르기용에서 뺌');
  const mine = myTraits(me);
  assert.ok(mine.startsWith('다은님 · 여 29세'));
  assert.ok(mine.includes(`자기소개: ${me.selfIntro}`));
  assert.ok(mine.includes('상대에게 바라는 것:') && mine.includes('[절대]'));
});

test('예선 조 편성: 8명 이하면 한 조, 많으면 8명 이하로 고르게', () => {
  assert.equal(splitGroups([1, 2, 3]).length, 1);
  const groups = splitGroups(Array.from({ length: 19 }, (_, i) => i));
  assert.equal(groups.length, 3);
  assert.ok(groups.every((g) => g.length <= BATCH_SIZE));
  assert.equal(groups.flat().length, 19);
});

test('고르기 요청 검증과 프롬프트: 후보는 A, B, C…로 부르고 스키마는 그 기호만 허용', () => {
  const req = sanitizePickRequest(pickBody);
  assert.equal(req.candidates[0].label, 'A');
  assert.equal(req.pick, Math.min(3, cands.length));
  const msgs = buildPickMessages(req);
  assert.equal(msgs[0].role, 'system');
  assert.ok(msgs[1].content.includes('[후보 A]') && msgs[1].content.includes('[나]'));
  assert.deepEqual(pickSchema(req.candidates, 3).properties.picks.items.properties.id.enum, req.candidates.map((c) => c.label));
  assert.throws(() => sanitizePickRequest({ me: '', candidates: [] }));
  assert.equal(sanitizePickRequest({ ...pickBody, candidates: Array(20).fill({ text: 'x' }) }).candidates.length, BATCH_SIZE);
});

test('LLM 답 해석: 없는 기호·중복은 버리고, 끊긴 JSON도 끝난 항목은 살림', () => {
  const req = sanitizePickRequest(pickBody);
  const picks = parsePicks('{"picks":[{"id":"B","reason":"[나]와 결혼 생각이 같아요."},{"id":"B","reason":"중복"},{"id":"Z","reason":"없음"},{"id":"A","reason":"좋아요"}]}', req.candidates, 3, '다은님');
  assert.deepEqual(picks.map((p) => p.id), ['B', 'A']);
  assert.equal(picks[0].reason, '다은님과 결혼 생각이 같아요.');
  const cut = parsePicks('{"picks":[{"id":"C","reason":"두 분 모두 카페를 좋아해요."},{"id":"A","reason":"끊긴 문', req.candidates, 3);
  assert.deepEqual(cut.map((p) => p.id), ['C']);
  assert.throws(() => parsePicks('{"picks":[]}', req.candidates, 3));
  assert.equal(tidyReason('두 분 모두 결혼 생각이 같아요. 그리고 둘 다 균형'), '두 분 모두 결혼 생각이 같아요.');
});

test('LLM이 없을 때: 규칙으로 고르고, 같은 형식으로 설명', () => {
  const picks = fallbackPicks(me, cands);
  assert.equal(picks.length, Math.min(3, cands.length));
  assert.equal(picks[0].id, rankMatches(me, pool).matches[0].profile.id);
  const text = fallbackMatchExplanation(me, cands[0].profile);
  for (const head of ['💞 매칭된 이유:', '🤝 잘 맞는 점:', '💬 맞춰 갈 점:', '☕ 첫 만남 추천:']) assert.ok(text.includes(head), head);
});

test('매칭 설명 요청: 두 사람의 특징과 다른 답이 들어가고, 이름이 없으면 거부', () => {
  const f = sanitizeExplainRequest(explainFacts(me, cands[0].profile, { distance: cands[0].distance, reason: 'AI 이유' }));
  assert.equal(f.meName, '다은님');
  assert.ok(f.them.includes('서로 다른 가치관 답:'));
  const user = buildExplainMessages(f)[1].content;
  assert.ok(user.includes('<다은님>') && user.includes(`<${f.themName}>`) && user.includes('AI 이유'));
  assert.throws(() => sanitizeExplainRequest({ ...f, themName: '' }));
});

// 가짜 Ollama: /api/tags, /api/generate(미리 올리기), /api/chat(스트리밍)만 흉내 냄
function fakeOllama({ tokens = ['💞 매칭된 ', '이유: 테스트'], models = ['exaone3.5:2.4b'] } = {}) {
  const seen = [];
  const server = http.createServer(async (req, res) => {
    if (req.url === '/api/tags') return res.end(JSON.stringify({ models: models.map((name) => ({ name })) }));
    let body = '';
    for await (const c of req) body += c;
    if (req.url === '/api/generate') return res.end('{}');
    const json = JSON.parse(body);
    seen.push(json);
    // format이 있으면 고르기 요청: 스키마에 맞는 JSON을 두 조각으로 나눠 보냄
    const out = json.format ? ['{"picks":[{"id":"B","reason":"두 분 모두 ', '결혼 생각이 같아요."},{"id":"A","reason":"관심사가 비슷해요."}]}'] : tokens;
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
    for (const t of out) res.write(`${JSON.stringify({ message: { content: t }, done: false })}\n`);
    res.end(`${JSON.stringify({ message: { content: '' }, done: true, eval_count: out.length })}\n`);
  });
  return new Promise((ok) => server.listen(0, () => ok({ server, url: `http://127.0.0.1:${server.address().port}`, seen })));
}
const listen = (app) => new Promise((ok) => app.listen(0, () => ok(`http://127.0.0.1:${app.address().port}`)));
const lines = async (r) => (await r.text()).trim().split('\n').map((l) => JSON.parse(l));
const post = (url, body) => fetch(url, { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) });

test('서버 API: LLM이 후보를 고르고(구조화 출력), 매칭 설명은 글자 단위로 흘려 보냄', async () => {
  const ollama = await fakeOllama();
  const app = createApp({ ollamaUrl: ollama.url });
  const base = await listen(app);
  try {
    assert.deepEqual(await (await fetch(`${base}/api/llm/status`)).json(), { ok: true, model: 'exaone3.5:2.4b', error: null });

    const r = await post(`${base}/api/ai-match`, pickBody);
    assert.equal(r.status, 200);
    const msgs = await lines(r);
    assert.equal(msgs[0].phase, 'read');
    const done = msgs.at(-1);
    assert.equal(done.done, true);
    assert.deepEqual(done.picks.map((p) => p.id), ['B', 'A']);
    assert.equal(done.picks[0].reason, '두 분 모두 결혼 생각이 같아요.');
    const sent = ollama.seen[0];
    assert.equal(sent.model, 'exaone3.5:2.4b');
    assert.ok(sent.format.properties.picks, '구조화 출력 스키마를 보냄');
    assert.ok(sent.messages[1].content.includes('[후보 A]'));

    const e = await post(`${base}/api/match-explain`, explainFacts(me, cands[0].profile));
    const parts = await lines(e);
    assert.equal(parts.filter((l) => l.t).map((l) => l.t).join(''), '💞 매칭된 이유: 테스트');
    assert.equal(parts.at(-1).done, true);
    assert.ok(ollama.seen[1].messages[1].content.includes('<다은님>'));

    assert.equal((await post(`${base}/api/ai-match`, { me: 'x', candidates: [] })).status, 400);
    assert.equal((await post(`${base}/api/match-explain`, '{}')).status, 400);
    assert.equal((await post(`${base}/api/ai-match`, 'x'.repeat(40_000))).status, 413);
    assert.equal((await post(`${base}/api/explain`, {})).status, 404);
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
    assert.equal((await post(`${base}/api/ai-match`, pickBody)).status, 502);
    assert.equal((await post(`${base}/api/match-explain`, explainFacts(me, cands[0].profile))).status, 502);
    assert.match((await (await fetch(`${base2}/api/llm/status`)).json()).error, /ollama pull/);
  } finally {
    off.close();
    app2.close();
    noModel.server.close();
  }
});
