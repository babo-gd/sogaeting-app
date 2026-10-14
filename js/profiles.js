// 테스트용 샘플 회원 생성 (시드 고정이라 매번 같은 사람들이 생성됨)
import { AVATARS, REGION_GROUPS, SMOKING, VALUE_QUESTIONS, INTERESTS, appearanceFor } from './data.js';

function mulberry32(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const MALE_NAMES = ['민준', '서준', '도윤', '예준', '시우', '하준', '지호', '주원', '지후', '준우', '현우', '건우', '우진', '선우', '연우', '유준', '정우', '승우', '승현', '시윤'];
const FEMALE_NAMES = ['서연', '서윤', '지우', '하윤', '서현', '민서', '하은', '지유', '윤서', '채원', '지민', '수아', '지아', '다은', '은서', '예은', '수빈', '소율', '예린', '지원'];
const SURNAMES = ['김', '이', '박', '최', '정', '강', '조', '윤', '장', '임'];
const JOBS = ['회사원', '디자이너', '개발자', '간호사', '교사', '대학원생', '공무원', '마케터', '연구원', '요리사', '회계사', '프리랜서', '약사', '기획자', '사진작가', '물리치료사'];
const TOGETHER_LINE = ['연인과 많은 시간을 함께하고 싶어요', '함께하는 시간도, 각자의 시간도 소중해요', '서로의 생활을 존중하는 연애를 원해요'];

// 성별마다 100명까지 이름이 겹치지 않도록 성 + 이름 조합 (k: 성별 안에서의 순번)
const uniqueName = (k, names) => SURNAMES[k % 10] + names[(Math.floor(k / 10) * 2 + (k % 2)) % names.length];
const hasBatchim = (word) => (word.charCodeAt(word.length - 1) - 0xac00) % 28 !== 0;
const hashOf = (s) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);

// 프로필 한 줄 소개
export function introOf(p) {
  const [a, b] = p.interests;
  const job = `${p.job}${hasBatchim(p.job) ? '이에요' : '예요'}`;
  return `${b ? `${a}·${b}` : a} 좋아하는 ${job}. ${TOGETHER_LINE[p.values.together.answer]}`;
}

// 샘플 답변 분포 (소개팅 앱 이용자 특성상 결혼·자녀 의향이 있는 쪽이 많도록)
const SAMPLE_ANSWER_WEIGHTS = { marriage: [0.35, 0.45, 0.15, 0.05], children: [0.55, 0.35, 0.1] };

export function emptyValues() {
  return Object.fromEntries(VALUE_QUESTIONS.map((q) => [q.id, { answer: 0, accept: [], importance: 10, dealbreaker: false }]));
}

export function defaultPrefs(partnerGender) {
  return {
    ageMin: 25,
    ageMax: 35,
    maxDistance: 30,
    height: { min: partnerGender === '남' ? 170 : 155, max: 195, level: 'nice' },
    smoking: { accept: ['비흡연'], level: 'must' },
    appearance: Object.fromEntries(appearanceFor(partnerGender).map((a) => [a.key, { accept: [], level: 'any' }])),
  };
}

export function defaultMe() {
  const values = emptyValues();
  const set = (id, answer, accept, importance, dealbreaker = false) => (values[id] = { answer, accept, importance, dealbreaker });
  set('relationship', 0, [0, 1], 10);
  set('conflict', 1, [0, 1], 50);
  set('money', 2, [0, 2], 10);
  set('tidy', 1, [0, 1], 10);
  set('together', 1, [0, 1], 10);
  set('priority', 1, [0, 1], 1);
  set('contact', 2, [1, 2], 10);
  set('datePlace', 2, [1, 2], 1);
  set('crowd', 1, [1, 2], 1);
  set('parents', 1, [0, 1, 2], 50);
  set('marriage', 1, [0, 1], 50, true);
  set('children', 0, [0, 1], 50);
  set('likeKids', 1, [0, 1, 2], 10);

  const prefs = defaultPrefs('남');
  prefs.appearance.hairLoss = { accept: ['없음'], level: 'must' };
  prefs.appearance.style = { accept: ['댄디', '정석'], level: 'nice' };

  return {
    id: 'me',
    name: '나',
    avatar: 'rabbit',
    gender: '여',
    age: 29,
    region: '서울 마포구',
    height: 163,
    smoking: '비흡연',
    appearance: { hair: '긴머리', skin: '하얗고 깨끗한', face: '오밀조밀한', style: '캐주얼' },
    prefs,
    values,
    interests: ['카페 방문', '전시회', '피아노', '독서', '요리하기'],
  };
}

export function generateProfiles(count = 200, seed = 20261014) {
  const rand = mulberry32(seed);
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];
  const between = (min, max) => min + Math.floor(rand() * (max - min + 1));
  const weighted = (weights) => {
    let r = rand();
    const i = weights.findIndex((w) => (r -= w) < 0);
    return i === -1 ? weights.length - 1 : i;
  };
  // Fisher–Yates: sort(() => rand() - 0.5)는 엔진마다 결과가 달라 시드 고정이 깨짐
  const sample = (arr, n) => {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a.slice(0, n);
  };
  // 시·도는 대략적인 인구 비율로 고르고, 그 안의 시·군·구는 균등하게
  const SIDO_WEIGHTS = { 서울: 19, 부산: 6, 대구: 4, 인천: 6, 광주: 3, 대전: 3, 울산: 2, 세종: 1, 경기: 26, 강원: 3, 충북: 3, 충남: 4, 전북: 3, 전남: 3, 경북: 5, 경남: 6, 제주: 1 };
  const sidoPool = REGION_GROUPS.flatMap((g) => Array(SIDO_WEIGHTS[g.sido] ?? 1).fill(g));
  const pickRegion = () => {
    const g = pick(sidoPool);
    return `${g.sido} ${pick(g.districts)[0]}`;
  };
  const interestNames = Object.keys(INTERESTS);

  return Array.from({ length: count }, (_, idx) => {
    const gender = idx % 2 === 0 ? '남' : '여';
    const partner = gender === '남' ? '여' : '남';
    const age = between(24, 38);
    const smoking = rand() < 0.75 ? '비흡연' : pick(SMOKING.slice(1));

    const appearance = Object.fromEntries(appearanceFor(gender).map((a) => [a.key, pick(a.options)]));
    if (appearance.hairLoss) appearance.hairLoss = rand() < 0.7 ? '없음' : pick(['약간 진행', '있음']);

    const prefs = defaultPrefs(partner);
    prefs.ageMin = Math.max(20, age - between(3, 6));
    prefs.ageMax = age + between(3, 6);
    prefs.maxDistance = pick([20, 30, 50, 100, 500]);
    prefs.height.level = pick(['any', 'nice', 'nice', 'must']);
    prefs.smoking =
      smoking === '비흡연'
        ? { accept: rand() < 0.6 ? ['비흡연'] : ['비흡연', '가끔'], level: pick(['must', 'must', 'nice']) }
        : { accept: [...SMOKING], level: 'any' };
    // 외모 조건은 한두 개 정도만 설정
    for (const attr of sample(appearanceFor(partner), between(0, 2))) {
      prefs.appearance[attr.key] = { accept: sample(attr.options, between(1, attr.options.length - 1)), level: pick(['must', 'nice', 'nice']) };
    }

    const values = Object.fromEntries(
      VALUE_QUESTIONS.map((q) => {
        const weights = SAMPLE_ANSWER_WEIGHTS[q.id];
        const answer = weights ? weighted(weights) : Math.floor(rand() * q.options.length);
        const others = q.options.map((_, i) => i).filter((i) => i !== answer);
        const accept = [answer, ...sample(others, between(0, others.length - 1))].sort();
        const importance = pick([0, 1, 10, 10, 10, 50, 50]);
        // 매우 중요한 질문 중 일부는 '절대 안 됨'
        const dealbreaker = importance === 50 && accept.length < q.options.length && rand() < 0.15;
        return [q.id, { answer, accept, importance, dealbreaker }];
      }),
    );

    const names = gender === '남' ? MALE_NAMES : FEMALE_NAMES;
    const id = `u${idx + 1}`;
    const profile = {
      id,
      name: uniqueName(Math.floor(idx / 2), names),
      // 직업은 id로 정해서, 기존 랜덤 순서(다른 값들)가 바뀌지 않게 함
      job: JOBS[hashOf(id) % JOBS.length],
      avatar: pick(AVATARS).id,
      gender,
      age,
      region: pickRegion(),
      height: gender === '남' ? between(165, 188) : between(152, 172),
      smoking,
      appearance,
      prefs,
      values,
      interests: sample(interestNames, between(3, 6)),
    };
    profile.intro = introOf(profile);
    return profile;
  });
}
