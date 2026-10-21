// LLM 매칭: 나와 후보들의 특징을 글로 리스트업 → LLM이 가장 잘 맞는 상대를 직접 고르고 이유를 씀
// 점수 계산은 하지 않음. 규칙은 "반드시" 조건(나이·거리·흡연 등) 거르기에만 씀
// 브라우저(특징 정리 · 대체 결과)와 서버(검증 · 프롬프트)가 함께 씀
import { VALUE_QUESTIONS } from './data.js';
import { rankMatches } from './matching.js';
import { callName } from './llm.js';

export const BATCH_SIZE = 8; // 작은 모델이 한 번에 비교할 후보 수
export const PICK_COUNT = 3; // 최종 추천 인원
export const LABELS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');

// 줄바꿈은 살리고 연속 공백만 하나로
const clip = (s, max = 200) => String(s ?? '').replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim().slice(0, max);
const hash = (s) => [...String(s)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);

// ---------- 1. 후보: 서로의 "반드시" 조건을 통과한 이성 ----------
// 추천 점수 순서가 LLM에 새지 않도록 id 해시 순서로 섞음
export function aiCandidates(me, pool) {
  return rankMatches(me, pool)
    .matches.map((m) => ({ profile: m.profile, distance: m.distance }))
    .sort((a, b) => hash(a.profile.id) - hash(b.profile.id));
}

// ---------- 2. 특징 리스트업 ----------
// CPU에서 도는 작은 모델이 빨리 읽도록 짧게: 선택지는 짧은 이름표로, 가치관은 핵심 질문만
const KEY_VALUES = ['marriage', 'children', 'conflict', 'together', 'contact', 'money'];
const SHORT_OPTIONS = {
  relationship: ['신뢰·솔직함', '배려·양보', '서로의 성장', '함께하는 즐거움'],
  conflict: ['바로 대화', '시간 갖고 대화', '먼저 사과', '풀릴 때까지 기다림'],
  money: ['적게 꾸준히', '모아서 한 번에', '예산 세워 계획적', '그때그때'],
  tidy: ['바로 정리', '하루 안에 정리', '주말에 몰아서', '신경 안 씀'],
  together: ['최대한 함께', '함께·각자 균형', '각자 생활 존중'],
  priority: ['내 일 우선', '둘 다 챙김', '연인 우선'],
  contact: ['수시로', '하루 서너 번', '하루 한두 번', '용건 있을 때만'],
  datePlace: ['집', '밖', '집·밖 반반'],
  crowd: ['활기찬 곳', '한적한 곳', '기분 따라'],
  parents: ['매우 가까움', '적당한 거리', '독립적', '어려운 편'],
  marriage: ['1~2년 안에', '좋은 사람 있으면 언젠가', '아직 모름', '생각 없음'],
  children: ['낳고 싶음', '상황 보고', '원치 않음'],
  likeKids: ['아주 좋아함', '좋아하는 편', '보통', '별로'],
};
const shortAnswer = (q, i) => SHORT_OPTIONS[q.id]?.[i] ?? q.options[i];
const answerOf = (p, q) => q.options[p.values?.[q.id]?.answer];
const wantsOf = (p, minImportance) =>
  VALUE_QUESTIONS.map((q) => {
    const v = p.values?.[q.id];
    if (!v || (v.importance ?? 0) < minImportance || !v.accept?.length || v.accept.length >= q.options.length) return null;
    return `${q.short}(${v.accept.map((i) => shortAnswer(q, i)).join('/')})${v.dealbreaker ? '[절대]' : ''}`;
  }).filter(Boolean);

// 한 사람의 특징을 몇 줄의 글로 (LLM 입력이자 화면에 보여 주는 "리스트업")
// full: 가치관 13개 전부 (매칭 설명용), 아니면 핵심 질문만 (후보 고르기용)
// 샘플 회원의 소개는 관심사로 자동 생성한 문장이라 고르기용에서는 뺌 (직접 쓴 소개만 넣음)
export function traitsOf(p, { label = '', distance = null, me = null, full = false } = {}) {
  const head = [label ? `[${label}]` : '', callName(p.name), `${p.gender} ${p.age}세`, p.job, `${p.region}${distance != null ? `(${Math.round(distance)}km)` : ''}`];
  const qs = full ? VALUE_QUESTIONS : VALUE_QUESTIONS.filter((q) => KEY_VALUES.includes(q.id));
  const lines = [head.filter(Boolean).join(' · ')];
  const intro = p.selfIntro ?? (full ? p.intro : '');
  if (intro) lines.push(`자기소개: ${clip(intro, 150)}`);
  lines.push(`관심사: ${(p.interests ?? []).join(', ') || '없음'}`);
  lines.push(`가치관: ${qs.map((q) => `${q.short}=${shortAnswer(q, p.values?.[q.id]?.answer)}`).join(', ')}`);
  const wants = wantsOf(p, 50);
  if (wants.length) lines.push(`꼭 바라는 것: ${wants.join(', ')}`);
  // 나와 비교한 사실 (점수 계산이 아니라 같은 답·같은 관심사를 그대로 나열)
  if (me) {
    const same = VALUE_QUESTIONS.filter((q) => p.values?.[q.id]?.answer === me.values?.[q.id]?.answer).map((q) => q.short);
    const shared = (p.interests ?? []).filter((i) => me.interests?.includes(i));
    lines.push(`나와 같은 답: ${same.join(', ') || '없음'} / 같은 관심사: ${shared.join(', ') || '없음'}`);
  }
  return lines.join('\n');
}

// 나(사용자)는 "중요" 이상인 바람까지 적음
export function myTraits(me, { full = false } = {}) {
  const lines = traitsOf(me, { full }).split('\n').filter((l) => !l.startsWith('꼭 바라는'));
  const wants = wantsOf(me, 10);
  if (wants.length) lines.push(`상대에게 바라는 것: ${wants.join(', ')}`);
  return lines.join('\n');
}

// 후보가 많으면 8명 이하로 고르게 나눔 (예선 조 편성). 8명 이하면 한 조
export function splitGroups(list, size = BATCH_SIZE) {
  const n = Math.ceil(list.length / size);
  if (n <= 1) return [list];
  const per = Math.ceil(list.length / n);
  return Array.from({ length: n }, (_, i) => list.slice(i * per, (i + 1) * per)).filter((g) => g.length);
}

// ---------- 3. 서버: 받은 값 검증 ----------
export function sanitizePickRequest(body) {
  if (!body || typeof body !== 'object') throw new Error('요청이 비어 있어요');
  const me = clip(body.me, 1500);
  if (!me) throw new Error('내 특징(me)이 필요해요');
  if (!Array.isArray(body.candidates) || !body.candidates.length) throw new Error('후보(candidates)가 필요해요');
  const candidates = body.candidates.slice(0, BATCH_SIZE).map((c, i) => ({ label: LABELS[i], text: clip(c?.text ?? c, 1200) }));
  if (candidates.some((c) => !c.text)) throw new Error('후보 특징이 비어 있어요');
  const pick = Math.max(1, Math.min(Number.isInteger(body.pick) ? body.pick : PICK_COUNT, candidates.length));
  return { me, meName: clip(body.meName, 20) || '회원님', candidates, pick };
}

export const PICK_SYSTEM = [
  '너는 소개팅 앱의 매칭 매니저야. [나]와 [후보]들의 특징을 읽고 [나]와 가장 잘 맞는 후보를 골라.',
  '판단 기준 (중요한 순서):',
  '1. 결혼 생각·자녀 계획이 서로 맞는지',
  '2. [나]가 바라는 것을 후보가 만족하고, 후보가 꼭 바라는 것도 [나]가 만족하는지',
  '3. 다툼 해결·연락 빈도·함께하는 시간 같은 연애 스타일이 비슷한지',
  '4. 관심사와 자기소개가 잘 어울리는지',
  '규칙: 목록에 적힌 내용만 근거로 써. 잘 맞는 후보부터 순서대로, 같은 후보는 한 번만.',
  'reason은 그 후보와 [나]의 공통점 하나를 짧은 존댓말 한 문장으로 써. 예: "두 분 모두 결혼은 언젠가, 아이는 낳고 싶어 해요."',
].join('\n');

export function buildPickMessages({ me, candidates, pick }) {
  const user = [
    '[나]',
    me,
    '',
    ...candidates.flatMap((c) => [`[후보 ${c.label}]`, c.text.replace(/^\[[A-Z]\]\s*·?\s*/, ''), '']),
    `위 후보 ${candidates.length}명 중 [나]와 가장 잘 맞는 ${pick}명을 골라 JSON으로 답해.`,
  ].join('\n');
  return [
    { role: 'system', content: PICK_SYSTEM },
    { role: 'user', content: user },
  ];
}

// Ollama 구조화 출력: 후보 기호만 고를 수 있게 enum으로 제한
export function pickSchema(candidates, pick) {
  return {
    type: 'object',
    properties: {
      picks: {
        type: 'array',
        minItems: pick,
        maxItems: pick,
        items: {
          type: 'object',
          // reason 길이 제한: CPU에서 글자 생성이 느려서 짧게
          properties: { id: { type: 'string', enum: candidates.map((c) => c.label) }, reason: { type: 'string', maxLength: 90 } },
          required: ['id', 'reason'],
        },
      },
    },
    required: ['picks'],
  };
}

// 이유 문장 다듬기: "[나]"는 호칭으로, 길이 제한에 잘린 문장은 마지막 문장 끝까지만
export function tidyReason(text, meName = '회원님') {
  // 호칭은 항상 "~님"(받침 있음)이라 조사를 과/은/이/을로 맞춤
  let r = clip(text, 300)
    .replace(/\[나\]\s*(와|과)/g, `${meName}과`)
    .replace(/\[나\]\s*(는|은)/g, `${meName}은`)
    .replace(/\[나\]\s*(가|이)(?![가-힣])/g, `${meName}이`)
    .replace(/\[나\]\s*(를|을)/g, `${meName}을`)
    .replace(/\[나\]/g, meName)
    .replace(/^\s*[,.]\s*/, '');
  if (r && !/[.!?요다]$/.test(r)) {
    const end = Math.max(...['. ', '요.', '요,', '다.', '요 '].map((e) => r.lastIndexOf(e)));
    r = end > 15 ? r.slice(0, end + 2).replace(/[ ,]$/, '').replace(/요$/, '요.') : `${r}…`;
  }
  return r || '특징이 잘 어울려서 골랐어요.';
}

// LLM 답(JSON 글자)을 검증: 없는 기호·중복은 버림
export function parsePicks(raw, candidates, pick, meName = '회원님') {
  let data;
  try {
    data = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    // 길이 제한에 걸려 JSON이 중간에 끊긴 경우: 끝까지 쓴 항목만 살림
    const found = [...String(raw).matchAll(/"id"\s*:\s*"([^"]+)"\s*,\s*"reason"\s*:\s*"([^"]*)"/g)];
    data = { picks: found.map(([, id, reason]) => ({ id, reason })) };
  }
  const labels = new Set(candidates.map((c) => c.label));
  const seen = new Set();
  const picks = [];
  for (const p of Array.isArray(data?.picks) ? data.picks : []) {
    const id = String(p?.id ?? '').trim().replace(/^후보\s*/, '').toUpperCase();
    if (!labels.has(id) || seen.has(id)) continue;
    seen.add(id);
    picks.push({ id, reason: tidyReason(p.reason, meName) });
    if (picks.length >= pick) break;
  }
  if (!picks.length) throw new Error('AI가 후보를 고르지 못했어요');
  return picks;
}

// ---------- 4. LLM을 쓸 수 없을 때: 규칙 기반으로 대신 고름 ----------
export function fallbackPicks(me, cands, pick = PICK_COUNT) {
  const ranked = rankMatches(me, cands.map((c) => c.profile)).matches;
  return ranked.slice(0, pick).map((m) => {
    const agree = m.values.details.filter((d) => d.iLike && d.theyLike && Math.max(d.myImportance, d.theirImportance) >= 10).slice(0, 2);
    const shared = m.interests.shared.slice(0, 2);
    const reason = [
      agree.length ? `${agree.map((d) => d.question.short).join(', ')}에 대한 생각이 서로 맞아요.` : '서로의 반드시 조건을 모두 만족해요.',
      shared.length ? `${shared.join(', ')}을(를) 함께 좋아해요.` : '',
    ].join(' ').trim();
    return { id: m.profile.id, reason };
  });
}

// ---------- 5. 매칭 성사 후 설명 ----------
export function sanitizeExplainRequest(body) {
  if (!body || typeof body !== 'object') throw new Error('요청이 비어 있어요');
  const out = {
    meName: clip(body.meName, 20) || '회원님',
    themName: clip(body.themName, 20),
    me: clip(body.me, 1500),
    them: clip(body.them, 1500),
    reason: clip(body.reason, 300),
  };
  if (!out.themName || !out.me || !out.them) throw new Error('두 사람의 특징이 필요해요');
  return out;
}

export const EXPLAIN_SYSTEM = [
  '너는 소개팅 앱에서 매칭이 성사된 두 사람에게, 둘이 왜 매칭됐는지 설명해 주는 도우미야.',
  '규칙:',
  '- [두 사람의 특징]에 적힌 내용만 사용해. 외모, 과거, 목록에 없는 취미는 절대 지어내지 마.',
  '- 사람은 적힌 호칭(예: 다은님, 도윤님) 그대로 부르고, 존댓말로 따뜻하게 써.',
  '- 아래 형식 그대로, 전체 7문장 이내로 짧게 써. 제목이나 머리말은 쓰지 마.',
  '',
  '형식:',
  '💞 매칭된 이유: (두 사람이 잘 맞는 핵심 이유 2문장)',
  '🤝 잘 맞는 점: (같은 가치관이나 관심사를 구체적으로 1~2문장)',
  '💬 맞춰 갈 점: (답이 다른 가치관 중 1가지를 부드럽게 1문장)',
  '☕ 첫 만남 추천: (같은 관심사나 상대 관심사로 할 만한 데이트 1문장)',
].join('\n');

export function buildExplainMessages(f) {
  const user = [
    '[두 사람의 특징]',
    `<${f.meName}>`,
    f.me,
    '',
    `<${f.themName}>`,
    f.them,
    f.reason ? `\n[AI가 매칭할 때 본 이유]\n${f.reason}` : '',
    `\n${f.meName}과 ${f.themName}이 왜 매칭됐는지 형식대로 설명해 줘.`,
  ].join('\n');
  return [
    { role: 'system', content: EXPLAIN_SYSTEM },
    { role: 'user', content: user },
  ];
}

// 설명에 쓸 두 사람의 특징 (서로 비교한 사실 포함)
export function explainFacts(me, them, { distance = null, reason = '' } = {}) {
  const diff = VALUE_QUESTIONS.filter((q) => them.values?.[q.id]?.answer !== me.values?.[q.id]?.answer).map(
    (q) => `${q.short}(${callName(me.name)} '${answerOf(me, q)}', ${callName(them.name)} '${answerOf(them, q)}')`,
  );
  return {
    meName: callName(me.name),
    themName: callName(them.name),
    me: myTraits(me, { full: true }),
    them: `${traitsOf(them, { distance, me, full: true })}\n서로 다른 가치관 답: ${diff.slice(0, 4).join(', ') || '없음'}`,
    reason,
  };
}

export function fallbackMatchExplanation(me, them, reason = '') {
  const same = VALUE_QUESTIONS.filter((q) => them.values?.[q.id]?.answer === me.values?.[q.id]?.answer);
  const diff = VALUE_QUESTIONS.filter((q) => them.values?.[q.id]?.answer !== me.values?.[q.id]?.answer);
  const shared = (them.interests ?? []).filter((i) => me.interests?.includes(i));
  const a = callName(me.name);
  const b = callName(them.name);
  const why = reason || (same.length ? `${a}과 ${b}은 ${same.slice(0, 2).map((q) => q.short).join(', ')}에 대한 답이 같아요.` : `${a}과 ${b}은 서로의 반드시 조건을 모두 만족해요.`);
  const good = same.length
    ? `${same.slice(0, 3).map((q) => `${q.short}('${answerOf(me, q)}')`).join(', ')}이(가) 같아요.`
    : '가치관 답은 서로 다르지만, 조건이 양쪽 모두 맞아요.';
  const talk = diff.length ? `${diff[0].short}은 조금 달라요(${a} '${answerOf(me, diff[0])}', ${b} '${answerOf(them, diff[0])}'). 서로의 방식을 편하게 이야기해 보세요.` : '크게 다른 가치관은 없어요.';
  const topic = shared[0] ?? them.interests?.[0];
  return [
    `💞 매칭된 이유: ${why}`,
    `🤝 잘 맞는 점: ${good}${shared.length ? ` ${shared.join(', ')}도 함께 좋아해요.` : ''}`,
    `💬 맞춰 갈 점: ${talk}`,
    `☕ 첫 만남 추천: ${topic ? `${topic} 이야기로 시작하거나 함께 즐겨 보세요.` : '서로 주말을 어떻게 보내는지 물어보세요.'}`,
  ].join('\n');
}
