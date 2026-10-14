// 매칭 엔진: 양방향 조건 필터 → 가치관 궁합 → 관심사 임베딩 유사도 → 종합 점수
import { VALUE_QUESTIONS, INTERESTS, INTEREST_DIMENSIONS, SCORE_WEIGHTS, appearanceFor } from './data.js';
import { findRegion } from './regions.js';

// ---------- 거리 ----------
export function distanceKm(regionA, regionB) {
  const a = findRegion(regionA);
  const b = findRegion(regionB);
  if (!a || !b) return Infinity;
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// ---------- 1. 조건 필터 (한 방향: seeker의 조건을 target이 만족하는지) ----------
export function checkConditions(seeker, target) {
  const must = []; // { label, ok, detail }
  const nice = [];
  const add = (label, ok, level, detail) => {
    if (level === 'must') must.push({ label, ok, detail });
    else if (level === 'nice') nice.push({ label, ok, detail });
  };
  const p = seeker.prefs;

  add('성별', seeker.gender !== target.gender, 'must', '이성 매칭');
  add('나이', target.age >= p.ageMin && target.age <= p.ageMax, 'must', `${p.ageMin}~${p.ageMax}세`);
  const km = distanceKm(seeker.region, target.region);
  add('거리', km <= p.maxDistance, 'must', `${p.maxDistance}km 이내`);

  if (p.height) {
    add('키', target.height >= p.height.min && target.height <= p.height.max, p.height.level, `${p.height.min}~${p.height.max}cm`);
  }
  if (p.smoking?.accept?.length) {
    add('흡연', p.smoking.accept.includes(target.smoking), p.smoking.level, p.smoking.accept.join('/'));
  }
  // 상대 성별에 해당하는 외모 항목만 평가
  for (const attr of appearanceFor(target.gender)) {
    const pref = p.appearance?.[attr.key];
    if (!pref?.accept?.length) continue;
    add(attr.label, pref.accept.includes(target.appearance?.[attr.key]), pref.level, pref.accept.join('/'));
  }
  // "절대 안 됨"으로 표시한 가치관 질문은 반드시 조건처럼 취급
  for (const q of VALUE_QUESTIONS) {
    const mine = seeker.values?.[q.id];
    if (!mine?.dealbreaker || !mine.accept?.length) continue;
    add(`가치관(${q.category})`, acceptsAnswer(mine, target.values?.[q.id]), 'must', q.short);
  }

  const failed = must.filter((c) => !c.ok);
  const niceScore = nice.length ? nice.filter((c) => c.ok).length / nice.length : 1;
  return { passed: failed.length === 0, failed, must, nice, niceScore, distance: km };
}

// ---------- 2. 가치관 궁합 ----------
// 바라는 답을 비워두면 모든 답을 허용
const acceptsAnswer = (mine, theirs) => !mine?.accept?.length || mine.accept.includes(theirs?.answer);

// A가 B에게 얼마나 만족하는지: B의 답이 A가 바라는 답에 들어가는 정도를 A의 중요도로 가중
function satisfaction(a, b) {
  let earned = 0;
  let possible = 0;
  for (const q of VALUE_QUESTIONS) {
    const mine = a.values?.[q.id];
    const theirs = b.values?.[q.id];
    if (!mine || !theirs || theirs.answer == null) continue;
    const weight = mine.importance ?? 0;
    if (weight === 0) continue;
    possible += weight;
    if (acceptsAnswer(mine, theirs)) earned += weight;
  }
  return possible === 0 ? 1 : earned / possible;
}

export function valuesCompatibility(a, b) {
  const aToB = satisfaction(a, b);
  const bToA = satisfaction(b, a);
  // 기하평균: 한쪽만 만족하면 점수가 크게 떨어짐
  const score = Math.sqrt(aToB * bToA);

  const details = VALUE_QUESTIONS.map((q) => {
    const mine = a.values?.[q.id] ?? {};
    const theirs = b.values?.[q.id] ?? {};
    return {
      question: q,
      myAnswer: q.options[mine.answer],
      theirAnswer: q.options[theirs.answer],
      iLike: acceptsAnswer(mine, theirs),
      theyLike: acceptsAnswer(theirs, mine),
      myImportance: mine.importance ?? 0,
      theirImportance: theirs.importance ?? 0,
      myDealbreaker: !!mine.dealbreaker,
      theirDealbreaker: !!theirs.dealbreaker,
    };
  });
  return { score, aToB, bToA, details };
}

// ---------- 3. 관심사 임베딩 ----------
const normalize = (v) => {
  const n = Math.hypot(...v);
  return n === 0 ? v.map(() => 0) : v.map((x) => x / n);
};
const dims = INTEREST_DIMENSIONS.length;
const normalizedInterests = Object.fromEntries(Object.entries(INTERESTS).map(([k, v]) => [k, normalize(v)]));
// 전체 평균을 빼서(센터링) "다들 갖는 공통 성분"을 제거 → 성향 차이가 잘 드러남
const centroid = Array.from({ length: dims }, (_, i) =>
  Object.values(normalizedInterests).reduce((s, v) => s + v[i], 0) / Object.keys(normalizedInterests).length,
);

export function embedInterests(interests = []) {
  const vecs = interests.map((i) => normalizedInterests[i]).filter(Boolean);
  if (!vecs.length) return null;
  const mean = Array.from({ length: dims }, (_, i) => vecs.reduce((s, v) => s + v[i], 0) / vecs.length);
  return normalize(mean.map((x, i) => x - centroid[i]));
}

export function topDimensions(interests, n = 3) {
  const v = embedInterests(interests);
  if (!v) return [];
  return v
    .map((x, i) => ({ name: INTEREST_DIMENSIONS[i], value: x }))
    .filter((d) => d.value > 0)
    .sort((a, b) => b.value - a.value)
    .slice(0, n)
    .map((d) => d.name);
}

export function interestSimilarity(a, b) {
  const va = embedInterests(a.interests);
  const vb = embedInterests(b.interests);
  const shared = (a.interests ?? []).filter((i) => (b.interests ?? []).includes(i));
  if (!va || !vb) return { score: 0.5, shared, cosine: 0 };
  const cosine = va.reduce((s, x, i) => s + x * vb[i], 0);
  return { score: (cosine + 1) / 2, shared, cosine };
}

// ---------- 4. 종합 ----------
export function matchPair(me, other) {
  const mine = checkConditions(me, other); // 내 조건을 상대가 만족?
  const theirs = checkConditions(other, me); // 상대 조건을 내가 만족?
  const passed = mine.passed && theirs.passed;
  const values = valuesCompatibility(me, other);
  const interests = interestSimilarity(me, other);
  const conditions = (mine.niceScore + theirs.niceScore) / 2;
  const total =
    SCORE_WEIGHTS.values * values.score + SCORE_WEIGHTS.interests * interests.score + SCORE_WEIGHTS.conditions * conditions;
  return { profile: other, passed, mine, theirs, values, interests, conditions, total, distance: mine.distance };
}

export function rankMatches(me, pool) {
  const results = pool.filter((p) => p.id !== me.id).map((p) => matchPair(me, p));
  return {
    matches: results.filter((r) => r.passed).sort((a, b) => b.total - a.total),
    excluded: results.filter((r) => !r.passed),
  };
}
