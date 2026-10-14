import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkConditions, matchPair, rankMatches, valuesCompatibility, interestSimilarity } from '../js/matching.js';
import { defaultMe, generateProfiles } from '../js/profiles.js';

const man = () => ({ ...generateProfiles(1)[0], id: 'm', gender: '남', age: 30, region: '서울 마포구', height: 178, smoking: '비흡연',
  appearance: { hairLoss: '없음', beard: '깔끔하게 면도', hair: '짧은머리', skin: '하얗고 깨끗한', face: '각진', style: '댄디' },
  values: Object.fromEntries(Object.entries(defaultMe().values).map(([k, v]) => [k, { ...v, dealbreaker: false }])) });

test('내 조건과 상대 조건을 모두 만족해야 매칭된다', () => {
  const me = defaultMe();
  const him = man();
  him.prefs = { ...him.prefs, ageMin: 25, ageMax: 35, maxDistance: 50, smoking: { accept: ['비흡연'], level: 'must' }, appearance: {} };
  assert.equal(matchPair(me, him).passed, true);

  him.prefs.ageMax = 27; // 상대가 원하는 나이에 내가 안 맞음
  const r = matchPair(me, him);
  assert.equal(r.passed, false);
  assert.equal(r.mine.passed, true);
  assert.deepEqual(r.theirs.failed.map((f) => f.label), ['나이']);
});

test('반드시 조건 불만족은 제외, 되면 좋음은 점수만 깎인다', () => {
  const me = defaultMe();
  const him = man();
  him.appearance.hairLoss = '있음';
  assert.equal(checkConditions(me, him).passed, false);
  him.appearance.hairLoss = '없음';
  him.appearance.style = '꾸안꾸'; // nice 조건 불만족
  const c = checkConditions(me, him);
  assert.equal(c.passed, true);
  assert.ok(c.niceScore < 1);
});

test('가치관 궁합: 동일한 사람은 100%, 한쪽 불만족이면 낮아짐', () => {
  const me = defaultMe();
  assert.equal(valuesCompatibility(me, me).score, 1);
  const other = structuredClone(me);
  other.values.marriage.answer = 3; // 내가 매우 중요하게 본 항목 불일치
  const v = valuesCompatibility(me, other);
  assert.ok(v.aToB < 1 && v.score < 1);
});

test('관심사 임베딩: 비슷한 성향이 더 높은 점수', () => {
  const art = { interests: ['피아노', '전시회'] };
  const art2 = { interests: ['그림', '공연·뮤지컬'] };
  const sport = { interests: ['러닝', '헬스'] };
  assert.ok(interestSimilarity(art, art2).score > interestSimilarity(art, sport).score);
});

test('샘플 회원 대상 랭킹이 동작한다', () => {
  const { matches, excluded } = rankMatches(defaultMe(), generateProfiles());
  assert.ok(matches.length > 0);
  assert.ok(matches.every((m, i) => i === 0 || matches[i - 1].total >= m.total));
  console.log(`매칭 ${matches.length}명 / 제외 ${excluded.length}명`, matches.slice(0, 3).map((m) => `${m.profile.name} ${(m.total*100).toFixed(0)}%`));
});

test('절대 안 됨 질문이 맞지 않으면 양방향 모두 추천에서 제외된다', () => {
  const me = defaultMe();
  const him = man();
  him.prefs = { ...him.prefs, ageMin: 25, ageMax: 35, maxDistance: 50, smoking: { accept: ['비흡연'], level: 'must' }, appearance: {} };
  him.values = structuredClone(me.values);
  for (const v of Object.values(him.values)) v.dealbreaker = false;
  assert.equal(matchPair(me, him).passed, true);

  him.values.marriage.answer = 3; // 내가 '절대 안 됨'으로 지정한 결혼 질문 불일치
  let r = matchPair(me, him);
  assert.equal(r.passed, false);
  assert.deepEqual(r.mine.failed.map((f) => f.label), ['가치관(결혼)']);

  him.values.marriage.answer = 1;
  him.values.tidy = { answer: 0, accept: [0], importance: 50, dealbreaker: true }; // 상대의 절대 조건에 내가 불일치
  r = matchPair(me, him);
  assert.equal(r.passed, false);
  assert.deepEqual(r.theirs.failed.map((f) => f.label), ['가치관(생활 습관)']);

  him.values.tidy.dealbreaker = false; // 매우 중요지만 절대는 아님 → 점수만 깎임
  r = matchPair(me, him);
  assert.equal(r.passed, true);
  assert.ok(r.values.bToA < 1);
});

import { emptyRequests, sendRequest, cancelRequest, respond, resolveDue, seedReceived, revealInfo, findRequest, REVEAL_MS } from '../js/requests.js';

test('매칭 신청: 대기 → 응답 시간이 지나면 승인/거절, 한 사람에게 한 번만', () => {
  const me = defaultMe();
  const { matches } = rankMatches(me, generateProfiles());
  const store = emptyRequests();
  const m = matches[0];
  const t0 = 1_000_000;
  sendRequest(store, m, t0);
  sendRequest(store, m, t0); // 중복 신청 무시
  assert.equal(store.sent.length, 1);
  assert.equal(findRequest(store, m.profile.id).status, 'pending');

  assert.deepEqual(resolveDue(store, t0 + 1000), []); // 아직 응답 전
  const decided = resolveDue(store, t0 + 120_000);
  assert.equal(decided.length, 1);
  assert.ok(['accepted', 'rejected'].includes(store.sent[0].status));
});

test('매칭 신청: 취소, 받은 신청 승인, 72시간 뒤 연락처 비공개', () => {
  const me = defaultMe();
  const { matches } = rankMatches(me, generateProfiles());
  const store = emptyRequests();
  sendRequest(store, matches[0], 0);
  cancelRequest(store, matches[0].profile.id);
  assert.equal(findRequest(store, matches[0].profile.id), null);

  seedReceived(store, matches, 0, 2);
  seedReceived(store, matches, 0, 2); // 한 번만 생성
  assert.equal(store.received.length, 2);
  const from = store.received[0].id;
  respond(store, from, true, 5000);
  const req = findRequest(store, from);
  assert.equal(req.status, 'accepted');
  assert.equal(revealInfo(req, 5000 + REVEAL_MS - 1).visible, true);
  assert.equal(revealInfo(req, 5000 + REVEAL_MS).expired, true);
});

import { explainTop, suggestRelaxations, applyRelaxation, exclusionReasons } from '../js/explain.js';

test('0명일 때: 이유를 보여주고, 제안한 완화를 적용하면 실제로 추천 인원이 늘어난다', () => {
  const pool = generateProfiles();
  const me = { ...defaultMe(), region: '강원 양구군' };
  const { matches, excluded } = rankMatches(me, pool);
  assert.equal(matches.length, 0);
  const reasons = exclusionReasons(me, excluded);
  assert.ok(reasons.length > 0 && reasons[0].count >= reasons.at(-1).count);

  const { base, suggestions } = suggestRelaxations(me, pool);
  assert.equal(base, 0);
  assert.ok(suggestions.length > 0);
  for (const s of suggestions) {
    const after = rankMatches(applyRelaxation(structuredClone(me), s), pool).matches.length;
    assert.equal(after, s.count);
    assert.ok(after > 0);
  }
  console.log('완화 제안:', suggestions.map((s) => `${s.text} +${s.gain}명`));
});

test('1위로 뽑힌 이유: 핵심 이유와 2위와의 차이를 설명한다', () => {
  const me = defaultMe();
  const { matches } = rankMatches(me, generateProfiles());
  const e = explainTop(me, matches);
  assert.ok(e.headline.endsWith('1위예요'));
  assert.equal(e.total, Math.round(matches[0].total * 100));
  assert.ok(e.vsSecond.totalGap >= 0);
  assert.ok(e.conditions.must.some((c) => c.startsWith('나이')));
  assert.equal(explainTop(me, []), null);
  console.log(e.headline, e.vsSecond);
});

import { recordView, isInterested, interestedMatches, viewSummary, VIEW_RULES } from '../js/views.js';
import { emptyChats, sendMessage, resolveReplies, seedChats, unreadTotal, markRead, icebreakers, getRoom } from '../js/chat.js';

test('머무는 시간: 1초 미만은 무시, 3번 이상 또는 15초 이상 본 사람을 다시 추천', () => {
  const { matches } = rankMatches(defaultMe(), generateProfiles());
  const [a, b, c] = matches.map((m) => m.profile.id);
  const views = {};
  recordView(views, a, 500); // 스쳐 지나감 → 무시
  assert.equal(views[a], undefined);
  for (let i = 0; i < VIEW_RULES.interestedCount; i++) recordView(views, a, 1200); // 여러 번
  recordView(views, b, 20_000); // 오래
  recordView(views, c, 2000); // 한 번 잠깐
  assert.ok(isInterested(views[a]) && isInterested(views[b]) && !isInterested(views[c]));
  const list = interestedMatches(views, matches);
  assert.deepEqual(list.map((x) => x.match.profile.id).sort(), [a, b].sort());
  assert.equal(interestedMatches(views, matches, (id) => id === a).length, 1); // 이미 연락 중이면 제외
  assert.equal(viewSummary(views[b]), '1번 · 총 20초 봤어요');
});

test('채팅: 먼저 보내면 방이 생기고, 상대 답장이 오면 안 읽음이 늘어난다', () => {
  const me = defaultMe();
  const { matches } = rankMatches(me, generateProfiles());
  const byId = (id) => matches.find((m) => m.profile.id === id);
  const chats = emptyChats();
  const id = matches[0].profile.id;
  assert.equal(getRoom(chats, id), null);
  assert.equal(sendMessage(chats, id, '   '), null); // 빈 메시지는 방을 만들지 않음
  assert.equal(getRoom(chats, id), null);
  assert.ok(icebreakers(me, matches[0]).length > 0);

  const room = sendMessage(chats, id, '안녕하세요!', 0);
  assert.equal(room.startedBy, 'me');
  assert.deepEqual(resolveReplies(chats, me, byId, 1000), []); // 아직 답장 전
  const arrived = resolveReplies(chats, me, byId, 10_000);
  assert.equal(arrived.length, 1);
  assert.equal(unreadTotal(chats), 1);
  markRead(chats, id);
  assert.equal(unreadTotal(chats), 0);
  // 보고 있는 방이면 안 읽음이 늘지 않음
  sendMessage(chats, id, '주말엔 뭐 하세요?', 20_000);
  resolveReplies(chats, me, byId, 40_000, id);
  assert.equal(unreadTotal(chats), 0);
  assert.equal(room.messages.length, 4);

  seedChats(chats, me, matches, 50_000);
  seedChats(chats, me, matches, 50_000);
  assert.equal(Object.keys(chats.rooms).length, 2); // 상대가 먼저 건 방 1개만 추가
  assert.equal(Object.values(chats.rooms).find((r) => r.startedBy === 'them').unread, 1);
});

import { funnel, scoreBreakdown, verdictOf } from '../js/explain.js';

test('가상 프로필: 20명 이상, 이름이 겹치지 않고 소개가 있다', () => {
  const pool = generateProfiles();
  assert.ok(pool.length >= 20);
  for (const g of ['남', '여']) {
    const names = pool.filter((p) => p.gender === g).map((p) => p.name);
    assert.equal(new Set(names).size, names.length);
  }
  assert.ok(pool.every((p) => p.job && p.intro.includes(p.job)));
});

test('추천 로직: 단계별 인원이 줄어들고, 점수 계산식의 합이 종합 점수와 맞는다', () => {
  const me = defaultMe();
  const f = funnel(me, generateProfiles());
  assert.ok(f.total >= f.opposite && f.opposite >= f.minePass && f.minePass >= f.bothPass && f.bothPass > 0);
  for (const m of f.matches) {
    const b = scoreBreakdown(m);
    assert.ok(Math.abs(b.total - m.total * 100) <= 0.15, `${b.total} vs ${m.total * 100}`);
  }
  const verdicts = f.excluded.filter((r) => r.profile.gender !== me.gender).map(verdictOf);
  assert.ok(verdicts.every((v) => !v.ok && v.reasons.length > 0));
  assert.equal(verdicts.filter((v) => v.stage === '내 조건').length, f.opposite - f.minePass);
});
