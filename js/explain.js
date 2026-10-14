// 추천 결과 설명: 1위로 뽑힌 이유, 0명일 때 조건 완화 제안
import { IMPORTANCE, VALUE_QUESTIONS, SCORE_WEIGHTS, appearanceFor } from './data.js';
import { rankMatches, topDimensions } from './matching.js';

const pct = (x) => Math.round(x * 100);
const importanceLabel = (w) => IMPORTANCE.find((i) => i.value === w)?.label;

const COMPONENTS = [
  { key: 'values', label: '가치관', headline: '가치관이 특히 잘 맞아서 1위예요', get: (m) => m.values.score },
  { key: 'interests', label: '관심사', headline: '관심사 성향이 특히 비슷해서 1위예요', get: (m) => m.interests.score },
  { key: 'conditions', label: '선호 조건', headline: '원하는 조건을 더 많이 만족해서 1위예요', get: (m) => m.conditions },
];

// ---------- 추천 로직 단계별 인원 ----------
// 전체 → 이성 → 내 반드시 조건 통과 → 상대 반드시 조건도 통과(= 추천)
export function funnel(me, pool) {
  const { matches, excluded } = rankMatches(me, pool);
  const opposite = pool.filter((p) => p.id !== me.id && p.gender !== me.gender);
  const minePass = matches.length + excluded.filter((r) => r.profile.gender !== me.gender && r.mine.passed).length;
  return { total: pool.length, opposite: opposite.length, minePass, bothPass: matches.length, matches, excluded };
}

// 종합 점수 = 가치관 60% + 관심사 25% + 선호 조건 15% 를 실제 숫자로 풀어 씀
export function scoreBreakdown(m) {
  const parts = COMPONENTS.map((c) => {
    const score = c.get(m) * 100;
    const contribution = Math.round(SCORE_WEIGHTS[c.key] * score * 10) / 10;
    return { key: c.key, label: c.label, weight: SCORE_WEIGHTS[c.key], score: Math.round(score), contribution };
  });
  const total = Math.round(parts.reduce((s, p) => s + p.contribution, 0) * 10) / 10;
  return { parts, total, rounded: Math.round(m.total * 100) };
}

// 한 사람이 추천되었는지, 아니면 어느 단계에서 왜 빠졌는지
export function verdictOf(r) {
  if (r.passed) return { ok: true, stage: '추천', reasons: [] };
  if (!r.mine.passed) return { ok: false, stage: '내 조건', reasons: r.mine.failed.map((f) => f.label) };
  return { ok: false, stage: '상대 조건', reasons: r.theirs.failed.map((f) => f.label) };
}

// ---------- 1위로 뽑힌 이유 ----------
export function explainTop(me, list) {
  const top = list[0];
  if (!top) return null;
  const second = list[1] ?? null;
  const p = top.profile;

  // 종합 점수에 실제로 더해진 몫(가중치 × 점수)으로 비교
  const parts = COMPONENTS.map((c) => ({
    ...c,
    score: c.get(top),
    weighted: SCORE_WEIGHTS[c.key] * c.get(top),
    gap: second ? SCORE_WEIGHTS[c.key] * (c.get(top) - c.get(second)) : null,
  }));
  // 2위가 있으면 2위보다 가장 많이 앞선 항목, 없으면 가장 크게 기여한 항목이 핵심 이유
  const lead = [...parts].sort((a, b) => (second ? b.gap - a.gap : b.weighted - a.weighted))[0];

  const details = top.values.details;
  const mineImportant = details.filter((d) => d.myImportance >= 10);
  const valueHighlights = details
    .filter((d) => d.iLike && d.theyLike && Math.max(d.myImportance, d.theirImportance) >= 10)
    .sort((a, b) => Math.max(b.myImportance, b.theirImportance) - Math.max(a.myImportance, a.theirImportance))
    .slice(0, 3)
    .map((d) => ({ emoji: d.question.emoji, short: d.question.short, answer: d.theirAnswer, importance: importanceLabel(Math.max(d.myImportance, d.theirImportance)) }));

  const myTendency = topDimensions(me.interests);
  const sharedTendency = topDimensions(p.interests).filter((t) => myTendency.includes(t));

  return {
    headline: lead.headline,
    lead: lead.key,
    total: pct(top.total),
    values: {
      score: pct(top.values.score),
      importantMatched: mineImportant.filter((d) => d.iLike).length,
      importantTotal: mineImportant.length,
      theyLikeMe: pct(top.values.bToA),
      highlights: valueHighlights,
    },
    interests: { score: pct(top.interests.score), shared: top.interests.shared, sharedTendency },
    conditions: {
      must: top.mine.must.filter((c) => c.label !== '성별').map((c) => (c.label.startsWith('가치관') ? `${c.detail} 일치` : `${c.label} ${c.detail}`)),
      niceMet: top.mine.nice.filter((c) => c.ok).length,
      niceTotal: top.mine.nice.length,
    },
    vsSecond: second
      ? {
          name: second.profile.name,
          totalGap: pct(top.total) - pct(second.total),
          parts: parts.map((c) => ({ label: c.label, gap: pct(c.get(top)) - pct(c.get(second)) })),
        }
      : null,
  };
}

// 홈 미리보기용 한 줄 이유
export function shortReason(me, list) {
  const e = explainTop(me, list);
  if (!e) return '';
  const bits = [`가치관 ${e.values.score}%`];
  if (e.interests.shared.length) bits.push(`공통 관심사 ${e.interests.shared.length}개`);
  else if (e.interests.sharedTendency.length) bits.push(`${e.interests.sharedTendency[0]} 성향`);
  if (e.values.highlights[0]) bits.push(`${e.values.highlights[0].short} 일치`);
  return bits.join(' · ');
}

// ---------- 0명일 때: 왜 0명인지 + 조건 완화 제안 ----------
export function exclusionReasons(me, excluded, limit = 4) {
  const counts = {};
  for (const r of excluded.filter((r) => r.profile.gender !== me.gender)) {
    for (const f of r.mine.failed) counts[`mine|${f.label}`] = (counts[`mine|${f.label}`] ?? 0) + 1;
    for (const f of r.theirs.failed) counts[`theirs|${f.label}`] = (counts[`theirs|${f.label}`] ?? 0) + 1;
  }
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([k, count]) => {
      const [side, label] = k.split('|');
      return { side, label, count };
    });
}

const distanceLabel = (d) => (d >= 2000 ? '거리 상관없음' : `${d}km 이내`);

// 내가 바꿀 수 있는 조건만 하나씩 완화해 보고, 추천 인원이 늘어나는 것만 제안
function relaxCandidates(me) {
  const out = [];
  const p = me.prefs;
  const nextDistance = [50, 100, 200, 500, 2000].filter((d) => d > p.maxDistance);
  for (const d of nextDistance) out.push({ type: 'distance', value: d, text: `거리를 ${distanceLabel(d)}로 넓히기`, group: 'distance' });
  for (const step of [3, 6]) {
    const min = Math.max(19, p.ageMin - step);
    const max = Math.min(70, p.ageMax + step);
    if (min !== p.ageMin || max !== p.ageMax) out.push({ type: 'age', min, max, text: `원하는 나이를 ${min}~${max}세로 넓히기`, group: 'age' });
  }
  if (p.smoking?.level === 'must' && p.smoking.accept?.length) out.push({ type: 'level', path: 'smoking', text: "흡연 조건을 '되면 좋음'으로 바꾸기", group: 'smoking' });
  if (p.height?.level === 'must') out.push({ type: 'level', path: 'height', text: "키 조건을 '되면 좋음'으로 바꾸기", group: 'height' });
  for (const a of appearanceFor(me.gender === '남' ? '여' : '남')) {
    const pref = p.appearance?.[a.key];
    if (pref?.level === 'must' && pref.accept?.length) out.push({ type: 'level', path: `appearance.${a.key}`, text: `${a.label} 조건을 '되면 좋음'으로 바꾸기`, group: a.key });
  }
  for (const q of VALUE_QUESTIONS) {
    if (me.values[q.id]?.dealbreaker) out.push({ type: 'dealbreaker', qid: q.id, text: `'${q.short}' 질문의 '절대 안 됨' 끄기`, group: q.id });
  }
  return out;
}

export function applyRelaxation(me, r) {
  if (r.type === 'distance') me.prefs.maxDistance = r.value;
  else if (r.type === 'age') Object.assign(me.prefs, { ageMin: r.min, ageMax: r.max });
  else if (r.type === 'level') {
    const target = r.path.split('.').reduce((o, k) => o[k], me.prefs);
    target.level = 'nice';
  } else if (r.type === 'dealbreaker') me.values[r.qid].dealbreaker = false;
  else if (r.type === 'all') r.steps.forEach((s) => applyRelaxation(me, s));
  return me;
}

const countWith = (me, pool, r) => rankMatches(applyRelaxation(structuredClone(me), r), pool).matches.length;

export function suggestRelaxations(me, pool, limit = 4) {
  const base = rankMatches(me, pool).matches.length;
  const best = new Map(); // 같은 종류(거리 등)는 인원이 늘어나는 가장 작은 변경 하나만
  for (const r of relaxCandidates(me)) {
    if (best.has(r.group)) continue;
    const count = countWith(me, pool, r);
    if (count > base) best.set(r.group, { ...r, count, gain: count - base });
  }
  const list = [...best.values()].sort((a, b) => b.gain - a.gain).slice(0, limit);

  // 하나씩으로는 안 늘면, 가능한 완화를 모두 합쳐 봄
  if (!list.length) {
    const all = relaxCandidates(me);
    const widest = all.filter((r, i) => all.findLastIndex((x) => x.group === r.group) === i);
    if (widest.length) {
      const r = { type: 'all', steps: widest, text: '내 조건을 한 번에 모두 넓히기', group: 'all' };
      const count = countWith(me, pool, r);
      if (count > base) list.push({ ...r, count, gain: count - base });
    }
  }
  return { base, suggestions: list };
}
