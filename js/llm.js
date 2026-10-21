// LLM 매칭 설명: 추천 알고리즘이 계산한 "사실"만 LLM에 주고, 사람이 읽기 좋은 설명으로 바꿔 달라고 함
// 브라우저(사실 정리 · 대체 설명)와 서버(검증 · 프롬프트)가 함께 씀

export const DEFAULT_MODEL = 'exaone3.5:2.4b';

// "김도윤" → "도윤님", "나"처럼 이름이 짧으면 "회원님"
export function callName(name = '') {
  const n = String(name).trim();
  if (/^[가-힣]{3}$/.test(n)) return `${n.slice(1)}님`;
  if (n.length >= 2) return `${n}님`;
  return '회원님';
}

const clip = (s, max = 120) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const list = (arr, max = 5) => (Array.isArray(arr) ? arr.slice(0, max).map((s) => clip(s)).filter(Boolean) : []);
const num = (n) => (Number.isFinite(Number(n)) ? Math.max(0, Math.min(100, Math.round(Number(n)))) : 0);

// ---------- 브라우저: 매칭 결과 → 사실 ----------
export function buildMatchFacts(me, m, { rank = null, headline = '' } = {}) {
  const p = m.profile;
  const meName = callName(me.name);
  const them = callName(p.name);
  const pct = (x) => Math.round(x * 100);

  const agree = m.values.details
    .filter((d) => d.iLike && d.theyLike && Math.max(d.myImportance, d.theirImportance) >= 10)
    .sort((a, b) => Math.max(b.myImportance, b.theirImportance) - Math.max(a.myImportance, a.theirImportance))
    .slice(0, 3)
    .map((d) =>
      d.myAnswer === d.theirAnswer
        ? `${d.question.short}: 둘 다 '${d.myAnswer}'`
        : `${d.question.short}: ${meName} '${d.myAnswer}', ${them} '${d.theirAnswer}'`,
    );

  const differ = m.values.details
    .map((d) => {
      const w = Math.max(!d.iLike && d.myImportance > 0 ? d.myImportance : 0, !d.theyLike && d.theirImportance > 0 ? d.theirImportance : 0);
      return { d, w };
    })
    .filter((x) => x.w > 0)
    .sort((a, b) => b.w - a.w)
    .slice(0, 2)
    .map(({ d }) => `${d.question.short}: ${meName} '${d.myAnswer}', ${them} '${d.theirAnswer}'`);

  return {
    me: meName,
    them,
    profile: clip(`${p.age}세, ${p.job ?? ''}, ${p.region}, ${Math.round(m.distance)}km`),
    rank: rank == null ? null : rank + 1,
    headline: clip(headline),
    total: pct(m.total),
    values: pct(m.values.score),
    interests: pct(m.interests.score),
    conditions: pct(m.conditions),
    agree,
    differ,
    sharedInterests: m.interests.shared.slice(0, 4),
    theirInterests: p.interests.slice(0, 4),
  };
}

// ---------- 서버: 받은 사실 검증 (길이 제한, 알 수 없는 값 버림) ----------
export function sanitizeFacts(f) {
  if (!f || typeof f !== 'object') throw new Error('facts가 필요해요');
  const out = {
    me: clip(f.me, 20) || '회원님',
    them: clip(f.them, 20),
    profile: clip(f.profile),
    rank: Number.isInteger(f.rank) && f.rank > 0 && f.rank < 1000 ? f.rank : null,
    headline: clip(f.headline, 60),
    total: num(f.total),
    values: num(f.values),
    interests: num(f.interests),
    conditions: num(f.conditions),
    agree: list(f.agree, 3),
    differ: list(f.differ, 2),
    sharedInterests: list(f.sharedInterests, 4),
    theirInterests: list(f.theirInterests, 4),
  };
  if (!out.them) throw new Error('상대 이름이 필요해요');
  return out;
}

export const SYSTEM_PROMPT = [
  '너는 소개팅 앱에서 추천 상대를 소개하는 도우미야.',
  '규칙:',
  '- [사실]에 적힌 내용만 사용해. 외모, 성격, 과거 등 사실에 없는 내용은 절대 지어내지 마.',
  '- 사람은 [사실]에 적힌 호칭(예: 다은님, 도윤님) 그대로 불러. 존댓말로 써.',
  '- 점수는 종합 궁합 점수만 한 번 말해.',
  '- 아래 형식 그대로, 전체 6문장 이내로 짧게 써. 제목이나 머리말은 쓰지 마.',
  '',
  '형식:',
  '💡 추천 이유: (잘 맞는 가치관과 공통 관심사를 근거로 2문장)',
  '💬 이야기해 볼 점: (다른 점이 있으면 그중 1가지를 부드럽게, 없으면 서로 더 알아갈 점을 1문장)',
  '☕ 첫 대화 주제: (공통 관심사나 상대 관심사로 1문장)',
].join('\n');

export function factsToText(f) {
  const lines = [
    '[사실]',
    `사용자: ${f.me}`,
    `추천 상대: ${f.them} (${f.profile})`,
    f.rank ? `추천 순위: ${f.rank}위${f.headline ? ` (${f.headline})` : ''}` : '',
    `종합 궁합: ${f.total}점 (가치관 ${f.values}점, 관심사 ${f.interests}점, 선호 조건 ${f.conditions}점)`,
    // 작은 모델이 사실을 섞지 않도록 한 줄에 사실 하나씩
    '잘 맞는 가치관:',
    ...(f.agree.length ? f.agree.map((a) => `- ${a}`) : ['- 없음']),
    '다른 점:',
    ...(f.differ.length ? f.differ.map((d) => `- ${d}`) : ['- 없음']),
    `공통 관심사: ${f.sharedInterests.length ? f.sharedInterests.join(', ') : '없음'}`,
    `${f.them}의 관심사: ${f.theirInterests.join(', ')}`,
  ];
  return lines.filter(Boolean).join('\n');
}

export const buildMessages = (facts) => [
  { role: 'system', content: SYSTEM_PROMPT },
  { role: 'user', content: factsToText(facts) },
];

// ---------- LLM을 쓸 수 없을 때: 같은 형식의 규칙 기반 설명 ----------
export function fallbackExplanation(f) {
  const strip = (s) => s.replace(/^[^:]+:\s*/, '');
  const reason = [
    f.agree.length ? `${f.me}과 ${f.them}은 ${f.agree.slice(0, 2).map((a) => a.split(':')[0]).join(', ')}에 대한 생각이 잘 맞아요.` : `${f.me}과 ${f.them}은 서로의 반드시 조건을 모두 만족해요.`,
    f.sharedInterests.length ? `${f.sharedInterests.join(', ')}을(를) 함께 좋아해서 종합 궁합 ${f.total}점이 나왔어요.` : `관심사 성향도 비슷해서 종합 궁합 ${f.total}점이 나왔어요.`,
  ].join(' ');
  const talk = f.differ.length
    ? `${f.differ[0].split(':')[0]}은 조금 달라요(${strip(f.differ[0])}). 서로의 방식을 편하게 이야기해 보세요.`
    : '크게 다른 가치관은 없어요. 연애할 때 바라는 점을 서로 더 알아가 보세요.';
  const topic = f.sharedInterests[0] ?? f.theirInterests[0];
  return `💡 추천 이유: ${reason}\n💬 이야기해 볼 점: ${talk}\n☕ 첫 대화 주제: ${topic ? `${topic} 이야기로 시작해 보세요. 최근에 즐긴 ${topic} 경험을 물어보면 자연스러워요.` : '서로 주말을 어떻게 보내는지 물어보세요.'}`;
}
