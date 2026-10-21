import { AVATARS, avatarOf, GENDERS, REGION_GROUPS, REGIONS, SMOKING, LEVELS, IMPORTANCE, VALUE_QUESTIONS, INTERESTS, INTEREST_DIMENSIONS, appearanceFor } from './data.js';
import { rankMatches, matchPair, embedInterests, topDimensions } from './matching.js';
import { defaultMe, defaultPrefs, generateProfiles } from './profiles.js';
import { findRegion, normalizeRegion } from './regions.js';
import {
  emptyRequests, findRequest, sendRequest, cancelRequest, respond, resolveDue, seedReceived,
  revealInfo, pendingReceivedCount, demoKakaoId, timeAgo, formatRemaining, STATUS_LABEL,
} from './requests.js';
import { explainTop, shortReason, suggestRelaxations, applyRelaxation, exclusionReasons, funnel, scoreBreakdown, verdictOf } from './explain.js';
import { emptyViews, recordView, interestedMatches, isInterested, viewSummary } from './views.js';
import { emptyChats, getRoom, sendMessage, markRead, unreadTotal, sortedRooms, resolveReplies, seedChats, icebreakers, MAX_MESSAGE } from './chat.js';
import { MAX_PHOTOS, loadPhotos, savePhotos, resizeImage } from './photos.js';
import { aiCandidates, traitsOf, myTraits, splitGroups, fallbackPicks, explainFacts, fallbackMatchExplanation, BATCH_SIZE, PICK_COUNT, LABELS } from './aimatch.js';
import { callName } from './llm.js';

const STORAGE_KEY = 'sogaeting.me.v1';
const pool = generateProfiles();
const profileById = new Map(pool.map((p) => [p.id, p]));
const KAKAO_ID = /^[A-Za-z0-9._-]{4,20}$/;
const partnerOf = (g) => (g === '남' ? '여' : '남');

const ICONS = {
  home: '<path d="M3.5 10.5 12 3.5l8.5 7V20a1 1 0 0 1-1 1H15v-6H9v6H4.5a1 1 0 0 1-1-1z"/>',
  results: '<path d="M12 20s-7.5-4.6-7.5-10.2A4.2 4.2 0 0 1 12 7.3a4.2 4.2 0 0 1 7.5 2.5C19.5 15.4 12 20 12 20z"/>',
  values: '<path d="M20 12a8 8 0 0 1-11.7 7.1L4 20l1-4A8 8 0 1 1 20 12z"/><path d="M8.5 12h.01M12 12h.01M15.5 12h.01"/>',
  my: '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 3.6-6 8-6s8 2 8 6"/>',
  inbox: '<rect x="3" y="5" width="18" height="14" rx="3"/><path d="m4 7 8 6 8-6"/>',
  chat: '<path d="M20 12a8 8 0 0 1-11.7 7.1L4 20l1-4A8 8 0 1 1 20 12z"/><path d="M8.5 12h.01M12 12h.01M15.5 12h.01"/>',
  send: '<path d="M4 12 20 4l-4 16-4-7-8-1z"/><path d="m12 13 8-9"/>',
  prev: '<path d="m14 6-6 6 6 6"/>',
  next: '<path d="m10 6 6 6-6 6"/>',
  back: '<path d="m15 5-7 7 7 7"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  chevron: '<path d="m9 5 7 7-7 7"/>',
  ai: '<path d="M12 3.5 13.8 9 19.5 10.5 13.8 12.2 12 18 10.2 12.2 4.5 10.5 10.2 9z"/><path d="M18.5 15.5v4M16.5 17.5h4"/>',
};
const icon = (name) => `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[name]}</svg>`;

const TABS = [
  { id: 'home', label: '홈' },
  { id: 'ai', label: 'AI 매칭' },
  { id: 'results', label: '추천' },
  { id: 'inbox', label: '신청함' },
  { id: 'chat', label: '채팅' },
  { id: 'my', label: '마이' },
];
const SUBS = { profile: '내 프로필', prefs: '원하는 조건', interests: '관심사', values: '가치관', logic: '나만의 추천 로직' };

// ai: LLM이 고른 결과, aiExplain: 매칭 성사 후 LLM 설명 (상대 id → 설명)
const freshState = () => ({ requests: emptyRequests(), views: emptyViews(), chats: emptyChats(), ai: null, aiExplain: {} });

let me = load();
let tab = 'home';
let sub = null; // 마이페이지 하위 화면
let qIndex = 0; // 가치관 질문 단계
let ob = null; // 가입 단계 (null이면 일반 화면)
let inboxTab = 'received'; // 신청함: 받은 신청 / 보낸 신청
let sheet = null; // 아래에서 올라오는 확인 창: { type: 'request' | 'accept', id }
let room = null; // 열려 있는 채팅방 상대 id (방이 아직 없으면 첫 메시지를 보낼 때 생성)
let photos = loadPhotos(); // 내 프로필 사진 (용량이 커서 따로 저장)

function load() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (saved?.prefs && saved?.values) return { avatar: 'rabbit', ...freshState(), ...saved, region: normalizeRegion(saved.region) };
  } catch {}
  return { ...defaultMe(), ...freshState() };
}
function save() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(me));
  } catch {}
}

// ---------- 경로 기반 상태 갱신 ----------
const getPath = (obj, path) => path.split('.').reduce((o, k) => o?.[k], obj);
function setPath(obj, path, value) {
  const keys = path.split('.');
  const last = keys.pop();
  const target = keys.reduce((o, k) => (o[k] ??= {}), obj);
  target[last] = value;
}

// ---------- 폼 컴포넌트 ----------
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const toOption = (o) => (typeof o === 'object' ? [o.value, o.label] : [o, o]);

// 짧은 선택지: 알약 모양 칩
function chips(path, options, { multi = false, num = false } = {}) {
  const current = getPath(me, path);
  return `<div class="chips">${options
    .map((o, i) => {
      const [value, label] = multi ? [num ? i : o, o] : toOption(o);
      const checked = multi ? (current ?? []).includes(value) : current === value;
      return `<label class="chip"><input type="${multi ? 'checkbox' : 'radio'}" name="${path}" data-path="${path}" ${multi ? 'data-multi' : ''} ${num ? 'data-num' : ''} value="${esc(value)}" ${checked ? 'checked' : ''}><span>${esc(label)}</span></label>`;
    })
    .join('')}</div>`;
}

// 긴 문장 선택지: 한 줄씩 꽉 찬 목록
function optionList(path, options, { multi = false } = {}) {
  const current = getPath(me, path);
  return `<div class="options">${options
    .map((label, i) => {
      const checked = multi ? (current ?? []).includes(i) : current === i;
      return `<label class="option ${multi ? 'multi' : ''}"><input type="${multi ? 'checkbox' : 'radio'}" name="${path}" data-path="${path}" ${multi ? 'data-multi' : ''} data-num value="${i}" ${checked ? 'checked' : ''}><span class="mark" aria-hidden="true"></span><span>${esc(label)}</span></label>`;
    })
    .join('')}</div>`;
}

// iOS 스타일 세그먼트 버튼
function segmented(path, options, { num = false, small = false } = {}) {
  const current = getPath(me, path);
  return `<div class="seg ${small ? 'small' : ''}" style="--n:${options.length}">${options
    .map((o) => {
      const [value, label] = toOption(o);
      return `<label><input type="radio" name="${path}" data-path="${path}" ${num ? 'data-num' : ''} value="${esc(value)}" ${current === value ? 'checked' : ''}><span>${esc(label)}</span></label>`;
    })
    .join('')}</div>`;
}

const numberInput = (path, { min, max, unit = '', label = '' } = {}) =>
  `<label class="num-field"><input type="number" inputmode="numeric" data-path="${path}" data-num value="${getPath(me, path) ?? ''}" ${min != null ? `min="${min}"` : ''} ${max != null ? `max="${max}"` : ''} aria-label="${label}"><span>${unit}</span></label>`;

const range = (minPath, maxPath, opts) =>
  `<div class="range">${numberInput(minPath, { ...opts, label: '최소' })}<span class="range-sep">~</span>${numberInput(maxPath, { ...opts, label: '최대' })}</div>`;

const select = (path, options, { num = false, label = '' } = {}) =>
  `<select data-path="${path}" ${num ? 'data-num' : ''} aria-label="${label}">${options
    .map((o) => {
      const [value, text] = toOption(o);
      return `<option value="${esc(value)}" ${getPath(me, path) === value ? 'selected' : ''}>${esc(text)}</option>`;
    })
    .join('')}</select>`;

function regionPicker() {
  const current = findRegion(me.region);
  const g = REGION_GROUPS.find((g) => g.sido === current?.sido) ?? REGION_GROUPS[0];
  return `<div class="pair"><select data-sido aria-label="시·도">${REGION_GROUPS.map(
    (x) => `<option value="${x.sido}" ${x === g ? 'selected' : ''}>${x.full}</option>`,
  ).join('')}</select>
    ${select('region', g.districts.map(([d]) => ({ value: `${g.sido} ${d}`, label: d })), { label: '시·군·구' })}</div>`;
}

const DISTANCES = [5, 10, 20, 30, 50, 100, 200, 500].map((v) => ({ value: v, label: `${v}km 이내` })).concat({ value: 2000, label: '거리 상관없음' });

function avatarPicker() {
  return `<div class="avatar-grid">${AVATARS.map(
    (a) => `<label class="avatar-pick"><input type="radio" name="avatar" data-path="avatar" value="${a.id}" ${me.avatar === a.id ? 'checked' : ''} aria-label="${a.id}"><span style="--avatar-bg:${a.bg}">${a.emoji}</span></label>`,
  ).join('')}</div>`;
}

// 동그란 프로필: 내 대표 사진이 있으면 사진, 없으면 캐릭터
const avatarEl = (p, cls = '') => {
  if (p === me && photos[0]) return `<div class="avatar photo ${cls}" aria-hidden="true"><img src="${photos[0]}" alt=""></div>`;
  const a = avatarOf(p.avatar);
  return `<div class="avatar ${cls}" style="--avatar-bg:${a.bg}" aria-hidden="true">${a.emoji}</div>`;
};

// 옆으로 넘기는 카드 (CSS scroll-snap이라 휴대폰에서는 손가락으로 밀면 넘어감)
function carousel(id, slides, overlay = '') {
  const n = slides.length;
  return `
    <div class="carousel" data-carousel="${id}">
      <div class="slides" tabindex="0" aria-label="사진 ${n}장, 옆으로 넘겨 보세요">
        ${slides.map((s, i) => `<div class="slide" role="group" aria-label="${i + 1} / ${n}">${s}</div>`).join('')}
      </div>
      ${overlay}
      ${
        n > 1
          ? `<button class="c-btn prev" data-c-move="-1" aria-label="이전 사진" disabled>${icon('prev')}</button>
             <button class="c-btn next" data-c-move="1" aria-label="다음 사진">${icon('next')}</button>
             <div class="c-dots" aria-hidden="true">${slides.map((_, i) => `<i class="${i === 0 ? 'on' : ''}"></i>`).join('')}</div>`
          : ''
      }
    </div>`;
}

// 프로필 슬라이드: 사진이 있으면 사진, 샘플 회원은 캐릭터 · 성향 · 가치관 소개 카드
function profileSlides(p) {
  if (p === me && photos.length) return photos.map((src, i) => `<img src="${src}" alt="내 프로필 사진 ${i + 1}">`);
  const a = avatarOf(p.avatar);
  const tendency = topDimensions(p.interests);
  const intro = ['marriage', 'conflict', 'together']
    .map((id) => VALUE_QUESTIONS.find((q) => q.id === id))
    .map((q) => `<li><span aria-hidden="true">${q.emoji}</span><div><small>${q.short}</small><b>${esc(q.options[p.values[q.id].answer])}</b></div></li>`)
    .join('');
  return [
    `<div class="slide-card s-avatar" style="--avatar-bg:${a.bg}"><span class="slide-emoji" aria-hidden="true">${a.emoji}</span><span class="slide-chip">사진 대신 캐릭터 프로필</span></div>`,
    `<div class="slide-card s-info"><small>이런 성향이에요</small><div class="big-tags">${tendency.map((t) => `<b>${t}</b>`).join('')}</div><p>${p.interests.map(esc).join(' · ')}</p>${p.intro ? `<p class="slide-intro">“${esc(p.intro)}”</p>` : ''}</div>`,
    `<div class="slide-card s-info"><small>가치관 한 줄 소개</small><ul class="slide-values">${intro}</ul></div>`,
  ];
}

// 내 프로필 사진 편집: 최대 3칸, 첫 번째가 대표 사진
function photoSlots() {
  const slots = Array.from({ length: MAX_PHOTOS }, (_, i) =>
    photos[i]
      ? `<div class="photo-slot filled">
           <img src="${photos[i]}" alt="프로필 사진 ${i + 1}">
           ${i === 0 ? '<span class="photo-main">대표</span>' : `<button class="photo-act" data-photo-main="${i}">대표로</button>`}
           <button class="photo-del" data-photo-del="${i}" aria-label="사진 ${i + 1} 삭제">✕</button>
         </div>`
      : `<label class="photo-slot empty">
           <input type="file" accept="image/*" multiple data-photo-input class="visually-hidden">
           <span aria-hidden="true">＋</span><small>${i === photos.length ? '사진 추가' : ''}</small>
         </label>`,
  ).join('');
  return `<div class="photo-grid">${slots}</div>
    <p class="hint">최대 ${MAX_PHOTOS}장 · 첫 번째 사진이 대표 사진이에요. 사진은 이 기기에만 저장돼요.</p>`;
}

const field = (label, control, hint = '', extra = '') =>
  `<div class="field">
    <div class="field-head"><span class="field-label">${label}</span>${extra}</div>
    ${hint ? `<p class="hint">${hint}</p>` : ''}
    ${control}
  </div>`;

const group = (title, body, desc = '') =>
  `<section class="group">
    ${title ? `<h2 class="group-title">${title}</h2>` : ''}
    ${desc ? `<p class="group-desc">${desc}</p>` : ''}
    <div class="card">${body}</div>
  </section>`;

const lockedBadge = '<span class="badge">반드시</span>';
const levelPicker = (path) => `<div class="level"><span class="level-label">이 조건은</span>${segmented(path, LEVELS, { small: true })}</div>`;

// 화면 조각: 여러 곳(마이페이지 하위 화면, 가입 단계)에서 재사용
const parts = {
  appearanceMine: () => appearanceFor(me.gender).map((a) => field(a.label, chips(`appearance.${a.key}`, a.options))).join(''),
  basicPrefs: () =>
    `${field('나이', range('prefs.ageMin', 'prefs.ageMax', { min: 19, max: 70, unit: '세' }), '', lockedBadge)}
     ${field('거리', select('prefs.maxDistance', DISTANCES, { num: true, label: '거리' }), '', lockedBadge)}`,
  smokingPref: () => field('흡연', chips('prefs.smoking.accept', SMOKING, { multi: true }) + levelPicker('prefs.smoking.level'), '아무것도 고르지 않으면 상관없음'),
  appearancePrefs: () =>
    `${field('키', range('prefs.height.min', 'prefs.height.max', { min: 140, max: 210, unit: 'cm' }) + levelPicker('prefs.height.level'))}
     ${appearanceFor(partnerOf(me.gender))
       .map((a) => field(a.label, chips(`prefs.appearance.${a.key}.accept`, a.options, { multi: true }) + levelPicker(`prefs.appearance.${a.key}.level`), '여러 개 고를 수 있어요'))
       .join('')}`,
  interests: () => chips('interests', Object.keys(INTERESTS), { multi: true }),
};

// ---------- 매칭 계산 (화면마다 다시 계산하지 않도록 렌더 1회당 한 번) ----------
let cache = null;
const matches = () => (cache ??= rankMatches(me, pool));

// ---------- 홈 ----------
function renderHome() {
  const steps = `
    ${group(
      '이렇게 매칭돼요',
      `<ol class="how">
        <li><span class="how-emoji">🔍</span><div><b>조건은 양쪽 모두</b><p>내 조건과 상대 조건을 둘 다 만족하는 사람만 추천해요</p></div></li>
        <li><span class="how-emoji">💬</span><div><b>가치관은 깊게</b><p>다툼 해결, 돈 관리, 결혼관까지 13가지 질문으로 궁합을 봐요</p></div></li>
        <li><span class="how-emoji">🎨</span><div><b>관심사는 성향으로</b><p>똑같은 취미가 아니어도 비슷한 성향이면 가깝게 매칭해요</p></div></li>
      </ol>
      <button class="link-row" data-open="logic">🧠 내 추천 로직을 실제 숫자로 보기<span aria-hidden="true">›</span></button>`,
    )}`;

  if (!me.onboarded) {
    return `
      <section class="home-hero">
        <div class="hero-emoji" aria-hidden="true">💛</div>
        <h2>생각이 통하는 사람과<br><mark>진짜 인연</mark>을 만나요</h2>
        <p>조건은 서로 맞게, 가치관은 깊게 맞춰드려요</p>
        <button class="cta" data-ob-start>1분 만에 시작하기</button>
      </section>
      <section class="stat-row">
        <div><b>${pool.length}</b><span>가입 회원</span></div>
        <div><b>${VALUE_QUESTIONS.length}</b><span>가치관 질문</span></div>
        <div><b>${REGIONS.length}</b><span>전국 시·군·구</span></div>
      </section>
      <p class="hint center">회원 수는 테스트용 샘플 데이터예요</p>
      ${steps}`;
  }

  const { matches: list } = matches();
  const top = list[0];
  const dealbreakers = Object.values(me.values).filter((v) => v.dealbreaker).length;
  const newRequests = pendingReceivedCount(me.requests);
  const matched = [...me.requests.sent, ...me.requests.received].filter((r) => revealInfo(r).visible).length;
  return `
    <section class="greet">
      ${avatarEl(me, 'lg')}
      <div><p>${esc(me.name)}님, 반가워요</p><h2>오늘의 추천이 도착했어요</h2></div>
    </section>
    <button class="banner ai" data-tab="ai"><span aria-hidden="true">🤖</span><b>LLM이 직접 골라 주는 AI 매칭</b><small>${me.ai ? '결과 보기' : '시작하기'}</small></button>
    ${newRequests ? `<button class="banner" data-inbox="received"><span aria-hidden="true">💌</span><b>새 매칭 신청 ${newRequests}건</b><small>확인하기</small></button>` : ''}
    ${matched ? `<button class="banner good" data-inbox="${me.requests.sent.some((r) => revealInfo(r).visible) ? 'sent' : 'received'}"><span aria-hidden="true">🎉</span><b>성사된 매칭 ${matched}건</b><small>카카오 ID 보기</small></button>` : ''}
    ${unreadTotal(me.chats) ? `<button class="banner" data-tab="chat"><span aria-hidden="true">💬</span><b>안 읽은 메시지 ${unreadTotal(me.chats)}개</b><small>채팅 보기</small></button>` : ''}
    ${interestedSection()}
    <section class="stat-row">
      <div><b>${list.length}<small>명</small></b><span>서로 맞는 사람</span></div>
      <div><b>${top ? Math.round(top.total * 100) : 0}<small>%</small></b><span>최고 궁합</span></div>
      <div><b>${dealbreakers}<small>개</small></b><span>절대 안 됨</span></div>
    </section>
    ${
      top
        ? `<section class="group"><h2 class="group-title">가장 잘 맞는 상대</h2>
            <button class="card preview" data-tab="results">
              ${avatarEl(top.profile)}
              <div class="preview-who"><b>${esc(top.profile.name)} <span>${top.profile.age}</span></b><p>${top.profile.region} · ${Math.round(top.distance)}km</p></div>
              <div class="ring sm" style="--p:${Math.round(top.total * 100)}"><b>${Math.round(top.total * 100)}</b></div>
              <p class="preview-why">👑 ${shortReason(me, list)}</p>
            </button>
            <button class="cta dark" data-tab="results">추천 상대 ${list.length}명 모두 보기</button></section>`
        : zeroGuide()
    }
    ${steps}`;
}

// ---------- 가입 단계 ----------
const OB_STEPS = [
  { emoji: '🐾', title: '나를 표현할<br>캐릭터를 골라주세요', sub: '사진 대신 캐릭터로 보여져서 부담 없어요', body: avatarPicker },
  { emoji: '📸', title: '프로필 사진을<br>추가해 주세요', sub: '최대 3장 · 건너뛰고 나중에 추가해도 돼요', body: photoSlots },
  { emoji: '👋', title: '뭐라고<br>불러드릴까요?', sub: '닉네임은 12자까지 쓸 수 있어요', body: () => `<input type="text" class="big-input" data-path="name" value="${esc(me.name)}" maxlength="12" autocomplete="nickname" aria-label="닉네임">` },
  { emoji: '🙋', title: '성별을<br>알려주세요', sub: '이성 회원을 추천해 드려요', body: () => segmented('gender', GENDERS) },
  { emoji: '🎂', title: '나이가<br>어떻게 되세요?', body: () => numberInput('age', { min: 19, max: 70, unit: '세', label: '나이' }) },
  { emoji: '📍', title: '어디에<br>살고 계세요?', sub: '가까운 사람을 찾을 때 써요', body: regionPicker },
  { emoji: '📏', title: '키와 흡연 여부를<br>알려주세요', body: () => `${field('키', numberInput('height', { min: 140, max: 210, unit: 'cm', label: '키' }))}${field('흡연', segmented('smoking', SMOKING))}` },
  { emoji: '🪞', title: '나의 외모를<br>골라주세요', sub: '가장 가까운 걸 골라주세요', body: parts.appearanceMine },
  { emoji: '💞', title: '어떤 분을<br>만나고 싶으세요?', sub: '나이와 거리는 꼭 지켜서 추천해요', body: parts.basicPrefs },
  { emoji: '🚭', title: '상대의 흡연 여부는<br>어떤 게 좋으세요?', body: parts.smokingPref },
  { emoji: '✨', title: '상대의 외모 취향을<br>알려주세요', sub: '반드시 · 되면 좋음 · 상관없음으로 정할 수 있어요', body: parts.appearancePrefs },
  { emoji: '🎨', title: '관심사를<br>골라주세요', sub: '비슷한 성향의 사람을 찾는 데 써요', body: parts.interests },
  { emoji: '✍️', title: '나를 짧게<br>소개해 주세요', sub: 'AI 매칭에서 LLM이 이 글을 읽고 어울리는 사람을 골라요', body: () => selfIntroInput() },
  { emoji: '💭', title: '마지막으로<br>가치관을 알려주세요', sub: `${VALUE_QUESTIONS.length}개 질문 · 약 3분이면 끝나요`, body: () => '<p class="ob-note">이 앱에서 가장 중요한 단계예요. 내 답과 상대에게 바라는 답, 중요도를 골라주세요.</p>' },
];

function renderOnboarding() {
  const step = OB_STEPS[ob];
  const last = ob === OB_STEPS.length - 1;
  return `
    <div class="flow">
      <header class="flow-top">
        <button class="icon-btn plain" data-ob="-1" aria-label="이전" ${ob === 0 ? 'disabled' : ''}>${icon('back')}</button>
        <div class="progress" role="progressbar" aria-valuemin="1" aria-valuemax="${OB_STEPS.length}" aria-valuenow="${ob + 1}"><div style="width:${((ob + 1) / OB_STEPS.length) * 100}%"></div></div>
        <button class="icon-btn plain" data-ob-exit aria-label="닫기">${icon('close')}</button>
      </header>
      <section class="flow-body">
        <div class="flow-emoji" aria-hidden="true">${step.emoji}</div>
        <h2>${step.title}</h2>
        ${step.sub ? `<p class="flow-sub">${step.sub}</p>` : ''}
        <div class="flow-control ${step.body === parts.interests ? '' : 'card-like'}">${step.body()}</div>
      </section>
      <footer class="flow-bottom">
        <button class="cta" ${last ? 'data-ob-done' : 'data-ob="1"'}>${last ? '가치관 질문 시작하기' : '다음'}</button>
      </footer>
    </div>`;
}

// ---------- 가치관 ----------
function renderValues() {
  const q = VALUE_QUESTIONS[qIndex];
  const base = `values.${q.id}`;
  const v = me.values[q.id];
  const last = qIndex === VALUE_QUESTIONS.length - 1;
  const dealbreaker =
    v.importance === 50
      ? `<label class="switch-row ${v.dealbreaker ? 'on' : ''}">
           <span><b>절대 안 됨</b><small>바라는 답이 아니면 추천에서 제외해요</small></span>
           <input type="checkbox" role="switch" data-path="${base}.dealbreaker" data-bool ${v.dealbreaker ? 'checked' : ''}>
           <span class="switch" aria-hidden="true"></span>
         </label>
         ${v.dealbreaker && !v.accept?.length ? '<p class="hint warn">바라는 상대의 답을 골라야 적용돼요</p>' : ''}`
      : '';

  return `
    <div class="stepper">
      <div class="progress" role="progressbar" aria-valuemin="1" aria-valuemax="${VALUE_QUESTIONS.length}" aria-valuenow="${qIndex + 1}">
        <div style="width:${((qIndex + 1) / VALUE_QUESTIONS.length) * 100}%"></div>
      </div>
      <div class="dots">${VALUE_QUESTIONS.map(
        (item, i) =>
          `<button class="dot ${i === qIndex ? 'current' : ''} ${me.values[item.id]?.dealbreaker ? 'flag' : ''}" data-q="${i}" aria-label="${i + 1}번 질문: ${item.short}">${item.emoji}</button>`,
      ).join('')}</div>
    </div>
    <section class="question ${v.dealbreaker ? 'is-dealbreaker' : ''}">
      <p class="q-meta"><span class="badge soft">${q.category}</span> ${qIndex + 1} / ${VALUE_QUESTIONS.length}</p>
      <div class="q-emoji" aria-hidden="true">${q.emoji}</div>
      <h2 class="q-text">${q.text}</h2>
      <div class="q-block">
        <h3>내 답</h3>
        ${optionList(`${base}.answer`, q.options)}
      </div>
      <div class="q-block">
        <h3>상대에게 바라는 답 <small>여러 개 가능 · 비우면 모두 괜찮음</small></h3>
        ${optionList(`${base}.accept`, q.options, { multi: true })}
      </div>
      <div class="q-block">
        <h3>얼마나 중요한가요?</h3>
        ${segmented(`${base}.importance`, IMPORTANCE, { num: true })}
        ${dealbreaker}
      </div>
    </section>
    <div class="step-nav">
      <button class="ghost" data-step="-1" ${qIndex === 0 ? 'disabled' : ''}>이전</button>
      ${last ? '<button class="primary" data-values-done>추천 상대 보기</button>' : '<button class="primary" data-step="1">다음 질문</button>'}
    </div>`;
}

// ---------- 마이페이지 ----------
function renderMy() {
  const { matches: list } = matches();
  const dealbreakers = Object.values(me.values).filter((v) => v.dealbreaker).length;
  const tags = topDimensions(me.interests);
  const menu = [
    { emoji: '👤', label: '내 프로필', desc: `${me.gender} · ${me.age}세 · ${me.region}`, attr: 'data-open="profile"' },
    { emoji: '💞', label: '원하는 조건', desc: `${me.prefs.ageMin}~${me.prefs.ageMax}세 · ${me.prefs.maxDistance >= 2000 ? '거리 상관없음' : `${me.prefs.maxDistance}km 이내`}`, attr: 'data-open="prefs"' },
    { emoji: '🎨', label: '관심사', desc: me.interests.length ? me.interests.slice(0, 3).join(', ') + (me.interests.length > 3 ? ` 외 ${me.interests.length - 3}개` : '') : '아직 고르지 않았어요', attr: 'data-open="interests"' },
    { emoji: '💭', label: '가치관 답변', desc: `${VALUE_QUESTIONS.length}개 질문 · 절대 안 됨 ${dealbreakers}개`, attr: 'data-open="values"' },
    { emoji: '🧠', label: '나만의 추천 로직', desc: '추천 상대를 고르는 단계와 계산식', attr: 'data-open="logic"' },
    { emoji: '🔄', label: '가입 단계 다시 하기', desc: '처음부터 차례대로 다시 입력해요', attr: 'data-ob-start' },
  ];
  return `
    <section class="my-head">
      ${avatarEl(me, 'xl')}
      <h2>${esc(me.name)}</h2>
      <p>${me.age}세 · ${me.region}</p>
      ${tags.length ? `<div class="chips static center">${tags.map((t) => `<span class="tag accent">${t}</span>`).join('')}</div>` : ''}
    </section>
    <section class="stat-row">
      <div><b>${list.length}<small>명</small></b><span>추천 상대</span></div>
      <div><b>${me.interests.length}<small>개</small></b><span>관심사</span></div>
      <div><b>${dealbreakers}<small>개</small></b><span>절대 안 됨</span></div>
    </section>
    <section class="group"><div class="card menu">${menu
      .map(
        (m) => `<button class="menu-row" ${m.attr}><span class="menu-emoji" aria-hidden="true">${m.emoji}</span><span class="menu-text"><b>${m.label}</b><small>${esc(m.desc)}</small></span>${icon('chevron')}</button>`,
      )
      .join('')}</div></section>`;
}

function renderProfile() {
  return `
    ${group(
      '프로필 사진',
      photoSlots() + (photos.length > 1 ? `<p class="field-label preview-label">다른 사람에게는 이렇게 넘겨 보여요</p>${carousel('me', profileSlides(me))}` : ''),
    )}
    ${group('캐릭터', avatarPicker(), '사진이 없을 때 사진 대신 보여요')}
    ${group(
      '기본 정보',
      `${field('닉네임', `<input type="text" data-path="name" value="${esc(me.name)}" maxlength="12" autocomplete="nickname">`)}
       ${field('성별', segmented('gender', GENDERS), '바꾸면 원하는 조건이 초기화돼요')}
       ${field('나이', numberInput('age', { min: 19, max: 70, unit: '세', label: '나이' }))}
       ${field('지역', regionPicker())}
       ${field('흡연', segmented('smoking', SMOKING))}`,
    )}
    ${group('자기소개', selfIntroInput(), 'AI 매칭에서 LLM이 이 글을 읽고 나와 어울리는 사람을 골라요')}
    ${group(
      '연락처',
      field(
        '카카오톡 ID',
        `<input type="text" data-path="kakaoId" value="${esc(me.kakaoId ?? '')}" maxlength="20" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="영문, 숫자, . _ - 4~20자">
         ${me.kakaoId && !KAKAO_ID.test(me.kakaoId) ? '<p class="hint warn">영문, 숫자, . _ - 로 4~20자를 입력해 주세요</p>' : ''}`,
        '매칭이 승인된 상대에게만 72시간 동안 보여요',
      ),
    )}
    ${group('내 외모', `${field('키', numberInput('height', { min: 140, max: 210, unit: 'cm', label: '키' }))}${parts.appearanceMine()}`)}`;
}

function renderPrefs() {
  return `
    <div class="notice">
      <p><b>반드시</b> 조건이 맞지 않으면 추천에서 빠지고, <b>되면 좋음</b>은 점수에만 반영돼요.</p>
      <p>상대가 정한 조건도 내가 맞아야 서로 추천돼요.</p>
    </div>
    ${group('필수 조건', parts.basicPrefs() + parts.smokingPref())}
    ${group('외모 조건', parts.appearancePrefs(), `${partnerOf(me.gender)}성 상대에게 바라는 외모예요.`)}`;
}

function vectorBars(interests) {
  const v = embedInterests(interests);
  if (!v) return '<p class="hint">관심사를 골라주세요.</p>';
  return `<div class="vector">${INTEREST_DIMENSIONS.map((d, i) => {
    const w = Math.round(Math.abs(v[i]) * 100);
    return `<div class="vrow"><span>${d}</span><div class="track"><div class="fill ${v[i] < 0 ? 'neg' : ''}" style="width:${w}%"></div></div></div>`;
  }).join('')}</div>`;
}

function renderInterests() {
  const tags = topDimensions(me.interests);
  return `
    <div class="notice"><p>같은 관심사가 아니어도 <b>비슷한 성향</b>이면 가깝게 매칭돼요. 예: 피아노 ↔ 전시회</p></div>
    ${group(`관심사 <span class="count">${me.interests.length}</span>`, parts.interests())}
    ${group(
      '내 성향',
      `${tags.length ? `<div class="chips static">${tags.map((t) => `<span class="tag accent">${t}</span>`).join('')}</div>` : ''}
       ${vectorBars(me.interests)}
       <p class="hint">진한 막대는 평균보다 강한 성향, 회색은 약한 성향이에요.</p>`,
    )}`;
}

// ---------- 추천 결과 ----------
const pct = (x) => Math.round(x * 100);
const bar = (label, value) =>
  `<div class="score-row"><span>${label}</span><div class="track"><div class="fill" style="width:${pct(value)}%"></div></div><b>${pct(value)}</b></div>`;

function matchCard(m, rank) {
  const p = m.profile;
  const important = m.values.details.filter((d) => Math.max(d.myImportance, d.theirImportance) >= 10);
  const agree = important.filter((d) => d.iLike && d.theyLike);
  // 서로 다른 부분: 누구 기준에서 안 맞는지와 그 중요도를 함께 계산해 중요한 순으로
  const conflict = m.values.details
    .map((d) => {
      const mineOff = !d.iLike && d.myImportance > 0;
      const theirsOff = !d.theyLike && d.theirImportance > 0;
      const weight = Math.max(mineOff ? d.myImportance : 0, theirsOff ? d.theirImportance : 0);
      const who = mineOff && theirsOff ? '서로 기준에 안 맞음' : mineOff ? '내 기준에 안 맞음' : '상대 기준에 안 맞음';
      return { ...d, off: mineOff || theirsOff, weight, who };
    })
    .filter((d) => d.off)
    .sort((a, b) => b.weight - a.weight);
  const severity = (w) => (w >= 50 ? 'high' : w >= 10 ? 'mid' : 'low');
  const importanceLabel = (w) => IMPORTANCE.find((i) => i.value === w)?.label;
  const niceList = [...m.mine.nice.map((c) => ({ ...c, who: '내 조건' })), ...m.theirs.nice.map((c) => ({ ...c, who: '상대 조건' }))];
  const looks = [`${p.height}cm`, p.smoking, ...appearanceFor(p.gender).map((a) => (a.key === 'hairLoss' ? `탈모 ${p.appearance[a.key]}` : p.appearance[a.key]))];

  return `
    <article class="card match" data-view-id="${p.id}">
      ${rank === 0 ? '<p class="best">👑 가장 잘 맞는 상대</p>' : ''}
      ${aiPickOf(p.id) ? '<p class="best ai">🤖 AI 매칭에서도 고른 상대</p>' : ''}
      ${carousel(p.id, profileSlides(p), isInterested(me.views[p.id]) ? `<span class="c-badge">👀 ${viewSummary(me.views[p.id])}</span>` : '')}
      <header class="match-head no-avatar">
        <div class="match-who">
          <h2><span class="rank">#${rank + 1}</span> ${esc(p.name)} <span>${p.age}</span></h2>
          <p>${esc(p.job)} · ${p.region} · ${Math.round(m.distance)}km</p>
        </div>
        <div class="ring" style="--p:${pct(m.total)}" aria-label="종합 궁합 ${pct(m.total)}%"><b>${pct(m.total)}</b><small>%</small></div>
      </header>
      <p class="intro-line">${esc(p.intro)}</p>
      ${rank === 0 ? topReason() : ''}
      <div class="chips static looks">${looks.map((l) => `<span class="tag">${esc(l)}</span>`).join('')}</div>

      <div class="scores">
        ${bar('가치관', m.values.score)}
        ${bar('관심사', m.interests.score)}
        ${bar('선호 조건', m.conditions)}
        ${formulaLine(m)}
      </div>

      <div class="block">
        <h3>관심사</h3>
        <div class="chips static">${p.interests.map((i) => `<span class="tag ${m.interests.shared.includes(i) ? 'accent' : ''}">${i}</span>`).join('')}</div>
      </div>

      ${
        agree.length
          ? `<div class="block"><h3>잘 맞는 가치관</h3>
              <ul class="agree">${agree.map((d) => `<li><span>${d.question.emoji} ${d.question.short}</span><b>${esc(d.theirAnswer)}</b></li>`).join('')}</ul></div>`
          : ''
      }

      ${
        conflict.length
          ? `<div class="block"><h3>대화가 필요한 부분 <small>중요한 순서</small></h3>
              <ul class="diffs">${conflict
                .map(
                  (d) => `<li class="diff ${severity(d.weight)}">
                    <div class="diff-head"><span>${d.question.emoji} ${d.question.short}</span><span class="diff-badge">${importanceLabel(d.weight)} · ${d.who}</span></div>
                    <dl class="diff-answers"><div><dt>나</dt><dd>${esc(d.myAnswer)}</dd></div><div><dt>상대</dt><dd>${esc(d.theirAnswer)}</dd></div></dl>
                  </li>`,
                )
                .join('')}</ul></div>`
          : ''
      }

      <details class="more">
        <summary>질문별 자세히 보기</summary>
        <p class="hint">내가 상대에게 만족 ${pct(m.values.aToB)}% · 상대가 나에게 만족 ${pct(m.values.bToA)}%<br>두 값의 기하평균이 가치관 궁합이에요.</p>
        <ul class="detail-list">
          ${m.values.details
            .map(
              (d) => `<li>
                <p class="detail-q">${d.question.emoji} ${d.question.short}</p>
                <dl class="diff-answers"><div><dt>나</dt><dd>${esc(d.myAnswer)}</dd></div><div><dt>상대</dt><dd>${esc(d.theirAnswer)}</dd></div></dl>
                <p class="detail-ok">
                  <span class="${d.iLike ? 'ok' : 'no'}">내 기준 ${d.iLike ? '맞음' : '안 맞음'} · ${d.myDealbreaker ? '절대 안 됨' : importanceLabel(d.myImportance)}</span>
                  <span class="${d.theyLike ? 'ok' : 'no'}">상대 기준 ${d.theyLike ? '맞음' : '안 맞음'} · ${d.theirDealbreaker ? '절대 안 됨' : importanceLabel(d.theirImportance)}</span>
                </p>
              </li>`,
            )
            .join('')}
        </ul>
        ${niceList.length ? `<h3>되면 좋음 조건</h3><div class="chips static">${niceList.map((c) => `<span class="tag ${c.ok ? 'good' : 'warn'}">${c.who} · ${c.label} ${c.ok ? '맞음' : '안 맞음'}</span>`).join('')}</div>` : ''}
      </details>
      ${isMatched(p.id) ? explainBlock(p.id) : ''}
      <div class="card-actions">${chatAction(p)}${requestAction(p)}</div>
    </article>`;
}

// 채팅: 서로 추천된 사이면 누구든 먼저 말을 걸 수 있음
function chatAction(p) {
  const r = getRoom(me.chats, p.id);
  return `<button class="cta chat-btn" data-room="${p.id}">💬 ${r ? '대화 이어가기' : '먼저 말 걸기'}${r?.unread ? `<i class="dot-badge">${r.unread}</i>` : ''}</button>`;
}

const inContact = (id) => !!findRequest(me.requests, id) || !!getRoom(me.chats, id);

// 여러 번 봤거나 오래 본 프로필을 다시 추천 (이미 신청·채팅 중인 사람은 제외)
function interestedSection() {
  const list = interestedMatches(me.views, matches().matches, inContact).slice(0, 6);
  if (!list.length) return '';
  return `
    <section class="group">
      <h2 class="group-title">👀 관심 있게 본 상대</h2>
      <p class="group-desc">여러 번 보거나 오래 본 프로필이에요. 먼저 다가가 보세요!</p>
      <div class="h-scroll">${list
        .map(
          ({ match: m, view: v }) => `
          <div class="mini">
            ${avatarEl(m.profile)}
            <b>${esc(m.profile.name)} <span>${m.profile.age}</span></b>
            <small>${viewSummary(v)}</small>
            <span class="mini-score">궁합 ${pct(m.total)}%</span>
            <div class="mini-actions">
              <button class="mini-btn" data-room="${m.profile.id}" aria-label="${esc(m.profile.name)}님에게 말 걸기">💬</button>
              <button class="mini-btn primary" data-req-open="${m.profile.id}">💌 신청</button>
            </div>
          </div>`,
        )
        .join('')}</div>
    </section>`;
}

// 추천 카드 아래의 매칭 신청 버튼: 현재 신청 상태에 따라 달라짐
function requestAction(p) {
  const req = findRequest(me.requests, p.id);
  if (!req) return `<button class="cta req-btn" data-req-open="${p.id}">💌 매칭 신청하기</button>`;
  if (req.status === 'accepted') return `<button class="cta dark req-btn" data-inbox="${req.dir}">🎉 매칭 성사 · 카카오 ID 보기</button>`;
  if (req.status === 'rejected') return `<button class="cta muted req-btn" disabled>매칭이 성사되지 않았어요</button>`;
  return req.dir === 'received'
    ? `<button class="cta req-btn" data-inbox="received">💌 나에게 신청했어요 · 응답하기</button>`
    : `<button class="cta soft req-btn" data-inbox="sent">⏳ 응답을 기다리고 있어요</button>`;
}

// ---------- 신청함 ----------
function requestCard(req) {
  const p = profileById.get(req.id);
  if (!p) return '';
  const m = matchPair(me, p);
  const reveal = revealInfo(req);
  const statusClass = { pending: 'pending', accepted: 'accepted', rejected: 'rejected' }[req.status];
  let body = '';
  if (req.status === 'pending' && req.dir === 'received') {
    body = `<div class="req-actions"><button class="ghost" data-reject="${p.id}">거절</button><button class="primary" data-accept="${p.id}">승인</button></div>`;
  } else if (req.status === 'pending') {
    body = `<p class="req-note">상대가 확인하면 알려드릴게요 <small>(체험용: 1분 안에 응답이 와요)</small></p>
            <button class="link-btn" data-cancel="${p.id}">신청 취소</button>`;
  } else if (reveal.visible) {
    body = `<div class="kakao">
              <div><small>${esc(p.name)}님의 카카오톡 ID</small><b>${demoKakaoId(p)}</b></div>
              <button class="copy-btn" data-copy="${demoKakaoId(p)}">복사</button>
            </div>
            <p class="req-note">⏰ ${formatRemaining(reveal.remainingMs)} · 내 ID <b>${esc(me.kakaoId ?? '')}</b>도 상대에게 보여요</p>
            ${explainBlock(p.id)}`;
  } else if (reveal.expired) {
    body = `<p class="req-note">연락처 공개 기간(72시간)이 끝났어요</p>${explainBlock(p.id)}`;
  } else {
    body = `<p class="req-note">${req.dir === 'sent' ? '아쉽게도 이번에는 매칭이 성사되지 않았어요' : '내가 거절한 신청이에요'}</p>`;
  }
  return `
    <article class="card req ${statusClass}">
      <header class="match-head">
        ${avatarEl(p)}
        <div class="match-who">
          <h2>${esc(p.name)} <span>${p.age}</span></h2>
          <p>${p.region} · ${Math.round(m.distance)}km</p>
        </div>
        <div class="ring sm" style="--p:${pct(m.total)}" aria-label="궁합 ${pct(m.total)}%"><b>${pct(m.total)}</b></div>
      </header>
      <p class="req-status"><span class="status ${statusClass}">${STATUS_LABEL[req.status]}</span><span>${req.dir === 'sent' ? '보낸 신청' : '받은 신청'} · ${timeAgo(req.at)}</span></p>
      ${body}
    </article>`;
}

function renderInbox() {
  const list = me.requests[inboxTab];
  const counts = { received: me.requests.received.length, sent: me.requests.sent.length };
  const newCount = pendingReceivedCount(me.requests);
  const empty =
    inboxTab === 'received'
      ? '<section class="empty"><div class="flow-emoji" aria-hidden="true">📭</div><p>아직 받은 신청이 없어요</p><p class="hint">프로필과 가치관을 자세히 채울수록 신청을 받기 쉬워요.</p></section>'
      : '<section class="empty"><div class="flow-emoji" aria-hidden="true">💌</div><p>아직 보낸 신청이 없어요</p><p class="hint">추천 상대에게 먼저 매칭을 신청해 보세요.</p><button class="cta" data-tab="results">추천 상대 보러 가기</button></section>';
  return `
    <div class="seg inbox-seg" style="--n:2" role="tablist">
      <label><input type="radio" name="inbox" data-inbox-tab="received" ${inboxTab === 'received' ? 'checked' : ''}><span>받은 신청 ${counts.received}${newCount ? `<i class="dot-badge">${newCount}</i>` : ''}</span></label>
      <label><input type="radio" name="inbox" data-inbox-tab="sent" ${inboxTab === 'sent' ? 'checked' : ''}><span>보낸 신청 ${counts.sent}</span></label>
    </div>
    <p class="hint inbox-hint">승인되면 72시간 동안 서로의 카카오톡 ID가 공개돼요.</p>
    ${list.length ? list.map(requestCard).join('') : empty}`;
}

// ---------- 확인 창 ----------
function renderSheet() {
  const p = profileById.get(sheet.id);
  const isAccept = sheet.type === 'accept';
  const needsId = !KAKAO_ID.test(me.kakaoId ?? '');
  return `
    <div class="sheet-backdrop" data-sheet-close></div>
    <div class="sheet" role="dialog" aria-modal="true" aria-labelledby="sheet-title">
      <div class="sheet-handle" aria-hidden="true"></div>
      ${avatarEl(p, 'lg')}
      <h2 id="sheet-title">${esc(p.name)}님${isAccept ? '의 신청을 승인할까요?' : '에게 매칭을 신청할까요?'}</h2>
      <p class="hint">${isAccept ? '승인하면 바로 서로의 카카오톡 ID가 72시간 동안 공개돼요.' : '상대가 승인하면 72시간 동안 서로의 카카오톡 ID가 공개돼요.'}</p>
      ${
        needsId
          ? `<label class="sheet-field"><span>내 카카오톡 ID</span>
               <input id="sheet-kakao" type="text" maxlength="20" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="영문, 숫자, . _ - 4~20자" value="${esc(me.kakaoId ?? '')}">
             </label>
             ${sheet.error ? `<p class="hint warn">${sheet.error}</p>` : ''}`
          : `<p class="sheet-id">내 카카오톡 ID <b>${esc(me.kakaoId)}</b></p>`
      }
      <div class="req-actions">
        <button class="ghost" data-sheet-close>취소</button>
        <button class="primary" data-sheet-confirm>${isAccept ? '승인하기' : '신청하기'}</button>
      </div>
    </div>`;
}

let toastTimer;
function showToast(message) {
  const el = document.querySelector('#toast');
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3000);
}

function renderResults() {
  const { matches: list, excluded } = matches();
  const candidates = pool.filter((p) => p.gender !== me.gender);
  const reasons = {};
  for (const r of excluded.filter((r) => r.profile.gender !== me.gender)) {
    for (const f of r.mine.failed) reasons[`내 조건 · ${f.label}`] = (reasons[`내 조건 · ${f.label}`] ?? 0) + 1;
    for (const f of r.theirs.failed) reasons[`상대 조건 · ${f.label}`] = (reasons[`상대 조건 · ${f.label}`] ?? 0) + 1;
  }
  const reasonList = Object.entries(reasons)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `<li><span>${k}</span><b>${v}명</b></li>`)
    .join('');

  const f = funnel(me, pool);
  return `
    <section class="hero">
      <p>가상 회원 ${f.total}명 중 이성 ${candidates.length}명</p>
      <h2><em>${list.length}명</em>과<br>서로 조건이 맞아요</h2>
      <ol class="mini-funnel" aria-label="추천 단계">
        <li><b>${f.opposite}</b><span>이성 회원</span></li>
        <li><b>${f.minePass}</b><span>내 조건 통과</span></li>
        <li><b>${f.bothPass}</b><span>상대 조건도 통과</span></li>
      </ol>
      <p class="hint">궁합 = 가치관 60% + 관심사 25% + 선호 조건 15% → 높은 순으로 추천</p>
      <button class="hero-btn" data-open="logic">🧠 나만의 추천 로직 자세히 보기</button>
      ${
        reasonList
          ? `<details class="more"><summary>제외된 이유 보기</summary><ul class="reasons">${reasonList}</ul><p class="hint">한 명이 여러 이유에 해당할 수 있어요.</p></details>`
          : ''
      }
    </section>
    ${list.length ? interestedSection() + list.slice(0, 20).map(matchCard).join('') : zeroGuide()}`;
}

// 카드마다 종합 점수를 실제 숫자로 풀어 쓴 계산식
function formulaLine(m) {
  const b = scoreBreakdown(m);
  return `<p class="formula" aria-label="점수 계산식">🧮 ${b.parts
    .map((p) => `${p.label} <b>${p.score}</b>×${p.weight}`)
    .join(' + ')} = <b>${b.total.toFixed(1)}</b> → <em>${b.rounded}점</em></p>`;
}

// ---------- 나만의 추천 로직 (통과 조건: 추천 상대와 고른 로직을 화면에 보여줌) ----------
let logicFilter = 'all';

function myMustRules() {
  const p = me.prefs;
  const rules = [`나이 ${p.ageMin}~${p.ageMax}세`, p.maxDistance >= 2000 ? '거리 상관없음' : `거리 ${p.maxDistance}km 이내`];
  if (p.smoking?.level === 'must' && p.smoking.accept?.length) rules.push(`흡연 ${p.smoking.accept.join('/')}`);
  if (p.height?.level === 'must') rules.push(`키 ${p.height.min}~${p.height.max}cm`);
  for (const a of appearanceFor(partnerOf(me.gender))) {
    const pref = p.appearance?.[a.key];
    if (pref?.level === 'must' && pref.accept?.length) rules.push(`${a.label} ${pref.accept.join('/')}`);
  }
  for (const q of VALUE_QUESTIONS) if (me.values[q.id]?.dealbreaker && me.values[q.id].accept?.length) rules.push(`${q.short} (절대 안 됨)`);
  return rules;
}

function renderLogic() {
  const f = funnel(me, pool);
  const top = f.matches[0];
  const steps = [
    { n: f.total, label: '전체 가상 회원' },
    { n: f.opposite, label: '이성 회원' },
    { n: f.minePass, label: '내 반드시 조건 통과' },
    { n: f.bothPass, label: '상대의 반드시 조건도 통과 = 추천' },
  ];
  const funnelHtml = steps
    .map((s) => `<li><div class="f-bar" style="--w:${Math.max(4, (s.n / f.total) * 100)}%"></div><b>${s.n}명</b><span>${s.label}</span></li>`)
    .join('');

  const tb = top ? scoreBreakdown(top) : null;
  const example = top
    ? `<div class="example">
        <p class="ex-title">예시: 1위 ${esc(top.profile.name)}님</p>
        <p>내 만족도 <b>${pct(top.values.aToB)}%</b> · 상대 만족도 <b>${pct(top.values.bToA)}%</b> → √(${top.values.aToB.toFixed(2)} × ${top.values.bToA.toFixed(2)}) = <b>${pct(top.values.score)}%</b></p>
        <p>관심사 코사인 유사도 ${top.interests.cosine.toFixed(2)} → (${top.interests.cosine.toFixed(2)} + 1) ÷ 2 = <b>${pct(top.interests.score)}%</b></p>
        <p>${tb.parts.map((p) => `${p.contribution.toFixed(1)}`).join(' + ')} = <b>${tb.total.toFixed(1)}점</b></p>
      </div>`
    : '';

  const rows = [...f.matches, ...f.excluded.filter((r) => r.profile.gender !== me.gender)]
    .map((r) => ({ r, v: verdictOf(r), rank: f.matches.indexOf(r) }))
    .filter(({ v }) => logicFilter === 'all' || (logicFilter === 'ok' ? v.ok : !v.ok && v.stage === logicFilter));
  const filterBtn = (id, label, n) =>
    `<label><input type="radio" name="logic-filter" data-logic-filter="${id}" ${logicFilter === id ? 'checked' : ''}><span>${label} ${n}</span></label>`;
  const mineFail = f.opposite - f.minePass;

  return `
    <section class="logic-hero">
      <p class="brand">나만의 추천 로직</p>
      <h2>${esc(me.name)}님의 추천 상대는<br>이렇게 골라져요</h2>
      <ol class="funnel">${funnelHtml}</ol>
    </section>

    <section class="group"><h2 class="group-title">① 양방향 반드시 조건</h2><div class="card logic-card">
      <p>내가 정한 반드시 조건을 <b>상대가</b> 만족하고, 상대가 정한 반드시 조건을 <b>내가</b> 만족해야 추천 후보가 돼요. 한쪽이라도 안 맞으면 점수와 상관없이 빠져요.</p>
      <div class="chips static">${myMustRules().map((r) => `<span class="tag accent">${esc(r)}</span>`).join('')}</div>
      <p class="hint">→ 내 조건에서 ${mineFail}명, 상대 조건에서 ${f.minePass - f.bothPass}명이 빠졌어요.</p>
    </div></section>

    <section class="group"><h2 class="group-title">② 가치관 궁합 · 60%</h2><div class="card logic-card">
      <p>질문마다 <b>내 답 · 상대에게 바라는 답 · 중요도</b>를 받아요. 중요도 가중치는 상관없음 0 · 조금 1 · 중요 10 · 매우 중요 50이에요.</p>
      <p class="eq">내 만족도 = Σ(중요도 × 상대 답이 내가 바라는 답이면 1) ÷ Σ중요도</p>
      <p class="eq">가치관 궁합 = √(내 만족도 × 상대 만족도)</p>
      <p class="hint">곱해서 제곱근을 씌우기 때문에 한쪽만 만족하면 점수가 크게 떨어져요.</p>
    </div></section>

    <section class="group"><h2 class="group-title">③ 관심사 성향 · 25%</h2><div class="card logic-card">
      <p>관심사 ${Object.keys(INTERESTS).length}개를 8가지 성향(${INTEREST_DIMENSIONS.join(', ')}) 위의 벡터로 바꿔요(임베딩). 같은 관심사가 아니어도 성향이 비슷하면 점수가 높아요.</p>
      <p class="eq">관심사 점수 = (코사인 유사도 + 1) ÷ 2</p>
      <p class="hint">내 성향: ${topDimensions(me.interests).join(' · ') || '관심사를 골라주세요'}</p>
    </div></section>

    <section class="group"><h2 class="group-title">④ 선호 조건 · 15%</h2><div class="card logic-card">
      <p>"되면 좋음"으로 정한 조건(키, 외모 등)을 얼마나 만족하는지를 양쪽 모두 계산해 평균 내요.</p>
    </div></section>

    <section class="group"><h2 class="group-title">⑤ 종합 점수로 순위 매기기</h2><div class="card logic-card">
      <p class="eq">종합 = 가치관 × 0.6 + 관심사 × 0.25 + 선호 조건 × 0.15</p>
      ${example}
      <p class="hint">추가 규칙: 3번 이상 또는 15초 이상 본 프로필은 "👀 관심 있게 본 상대"로 다시 추천해요.</p>
    </div></section>

    <section class="group">
      <h2 class="group-title">가상 이성 회원 전체 ${f.opposite}명</h2>
      <p class="group-desc">한 명씩 추천됐는지, 빠졌다면 어느 단계에서 왜 빠졌는지 보여줘요.</p>
      <div class="seg logic-seg" style="--n:4">
        ${filterBtn('all', '전체', f.opposite)}${filterBtn('ok', '추천', f.bothPass)}${filterBtn('내 조건', '내 조건 ✕', mineFail)}${filterBtn('상대 조건', '상대 ✕', f.minePass - f.bothPass)}
      </div>
      <div class="card member-list">${rows
        .map(
          ({ r, v, rank }) => `<div class="member ${v.ok ? 'ok' : 'no'}">
            ${avatarEl(r.profile)}
            <div class="member-text"><b>${esc(r.profile.name)} <small>${r.profile.age} · ${esc(r.profile.job)} · ${r.profile.region}</small></b>
              <span>${v.ok ? `✅ 추천 ${rank + 1}위 · ${pct(r.total)}점` : `❌ ${v.stage}에서 제외 · ${v.reasons.map(esc).join(', ')}`}</span></div>
          </div>`,
        )
        .join('')}</div>
    </section>`;
}

// ---------- 채팅 ----------
const clock = (at) => new Date(at).toLocaleTimeString('ko-KR', { hour: 'numeric', minute: '2-digit' });
const canChat = (id) => !!getRoom(me.chats, id) || matches().matches.some((m) => m.profile.id === id);

function renderChatList() {
  const rooms = sortedRooms(me.chats).filter((r) => profileById.has(r.id));
  const fresh = matches().matches.filter((m) => !getRoom(me.chats, m.profile.id)).slice(0, 10);
  return `
    <p class="hint inbox-hint">서로 추천된 사이라면 누구든 먼저 메시지를 보낼 수 있어요. 첫 메시지를 보내면 채팅방이 생겨요.</p>
    ${
      fresh.length
        ? `<section class="group"><h2 class="group-title">먼저 말 걸어 보세요</h2>
            <div class="h-scroll avatars">${fresh
              .map((m) => `<button class="avatar-btn" data-room="${m.profile.id}">${avatarEl(m.profile)}<span>${esc(m.profile.name)}</span></button>`)
              .join('')}</div></section>`
        : ''
    }
    <section class="group">
      <h2 class="group-title">대화 ${rooms.length}</h2>
      ${
        rooms.length
          ? `<div class="card room-list">${rooms
              .map((r) => {
                const p = profileById.get(r.id);
                const last = r.messages.at(-1);
                return `<button class="room-row" data-room="${r.id}">
                  ${avatarEl(p)}
                  <span class="room-text"><b>${esc(p.name)} <small>${p.age}</small></b><span>${last ? `${last.from === 'me' ? '나: ' : ''}${esc(last.text)}` : ''}</span></span>
                  <span class="room-meta"><small>${last ? timeAgo(last.at) : ''}</small>${r.unread ? `<i class="dot-badge">${r.unread}</i>` : ''}</span>
                </button>`;
              })
              .join('')}</div>`
          : `<section class="empty"><div class="flow-emoji" aria-hidden="true">💬</div><p>아직 대화가 없어요</p><p class="hint">추천 상대에게 먼저 말을 걸어 보세요.</p><button class="cta" data-tab="results">추천 상대 보러 가기</button></section>`
      }
    </section>`;
}

function chatLog() {
  const r = getRoom(me.chats, room);
  const p = profileById.get(room);
  if (!r) {
    const m = matchPair(me, p);
    return `<div class="room-intro">
        ${avatarEl(p, 'xl')}
        <p><b>${esc(p.name)}</b>님과 서로 추천됐어요</p>
        <p class="hint">궁합 ${pct(m.total)}% · 첫 메시지를 보내면 채팅방이 만들어져요</p>
        <div class="ice">${icebreakers(me, m).map((t) => `<button class="ice-btn" data-ice="${esc(t)}">${esc(t)}</button>`).join('')}</div>
      </div>`;
  }
  let lastDay = '';
  const items = r.messages
    .map((msg) => {
      const day = new Date(msg.at).toLocaleDateString('ko-KR', { month: 'long', day: 'numeric', weekday: 'short' });
      const sep = day !== lastDay ? `<li class="day">${day}</li>` : '';
      lastDay = day;
      return `${sep}<li class="msg ${msg.from}">${msg.from === 'them' ? avatarEl(p, 'sm') : ''}<p>${esc(msg.text).replace(/\n/g, '<br>')}</p><time>${clock(msg.at)}</time></li>`;
    })
    .join('');
  const typingRow = r.replyAt ? `<li class="msg them typing">${avatarEl(p, 'sm')}<p aria-label="입력 중"><i></i><i></i><i></i></p></li>` : '';
  return `<p class="room-start">${r.startedBy === 'me' ? '내가' : `${esc(p.name)}님이`} 먼저 말을 걸어 채팅방이 생겼어요</p><ul class="msgs">${items}${typingRow}</ul>`;
}

function renderRoom() {
  const p = profileById.get(room);
  const m = matchPair(me, p);
  return `
    <div class="room">
      <header class="room-top">
        <button class="icon-btn plain" data-room-close aria-label="채팅 목록으로">${icon('back')}</button>
        ${avatarEl(p, 'sm')}
        <div class="room-who"><b>${esc(p.name)}</b><small>궁합 ${pct(m.total)}% · ${p.region}</small></div>
      </header>
      <div id="chat-log" class="room-log">${chatLog()}</div>
      <form class="composer" data-chat-form>
        <textarea id="chat-input" rows="1" maxlength="${MAX_MESSAGE}" placeholder="메시지를 입력하세요" aria-label="메시지"></textarea>
        <button class="send-btn" type="submit" aria-label="보내기">${icon('send')}</button>
      </form>
    </div>`;
}

// 입력 중인 글이 지워지지 않도록 메시지 목록만 다시 그림
function refreshChatLog() {
  const log = document.querySelector('#chat-log');
  if (!log) return;
  log.innerHTML = chatLog();
  log.scrollTop = log.scrollHeight;
}

function openRoom(id) {
  if (!canChat(id)) return showToast('서로 추천된 사이에서만 대화할 수 있어요');
  room = id;
  markRead(me.chats, id);
  save();
  render();
  refreshChatLog();
}

function submitChat(text) {
  const r = sendMessage(me.chats, room, text);
  if (!r) return;
  save();
  refreshChatLog();
}

// 1위 카드에 붙는 "1위로 추천한 이유"
function topReason() {
  const e = explainTop(me, matches().matches);
  if (!e) return '';
  const sign = (n) => (n > 0 ? `+${n}` : `${n}`);
  const highlights = e.values.highlights.length
    ? `<div class="chips static">${e.values.highlights.map((h) => `<span class="tag good">${h.emoji} ${h.short}: ${esc(h.answer)}</span>`).join('')}</div>`
    : '';
  const interestLine = [
    e.interests.shared.length ? `공통 관심사 ${e.interests.shared.join(', ')}` : '',
    e.interests.sharedTendency.length ? `둘 다 ${e.interests.sharedTendency.join(' · ')} 성향` : '',
  ].filter(Boolean).join(' · ') || '관심사는 다르지만 성향 차이가 크지 않아요';
  return `
    <section class="why" aria-label="1위로 추천한 이유">
      <h3>👑 1위로 추천한 이유</h3>
      <p class="why-headline">${e.headline}</p>
      <ul class="why-list">
        <li class="${e.lead === 'values' ? 'lead' : ''}">
          <span class="why-ico" aria-hidden="true">💬</span>
          <div><b>가치관 궁합 ${e.values.score}%</b>
            <p>${e.values.importantTotal ? `내가 중요하게 본 질문 ${e.values.importantTotal}개 중 ${e.values.importantMatched}개가 맞아요 · ` : ''}상대도 나에게 ${e.values.theyLikeMe}% 만족해요</p>
            ${highlights}</div>
        </li>
        <li class="${e.lead === 'interests' ? 'lead' : ''}">
          <span class="why-ico" aria-hidden="true">🎨</span>
          <div><b>관심사 성향 ${e.interests.score}%</b><p>${esc(interestLine)}</p></div>
        </li>
        <li class="${e.lead === 'conditions' ? 'lead' : ''}">
          <span class="why-ico" aria-hidden="true">✅</span>
          <div><b>반드시 조건 모두 만족</b>
            <p>${e.conditions.must.map(esc).join(' · ')}${e.conditions.niceTotal ? ` · 되면 좋음 ${e.conditions.niceTotal}개 중 ${e.conditions.niceMet}개 만족` : ''}</p></div>
        </li>
      </ul>
      ${
        e.vsSecond
          ? `<p class="why-vs">2위 ${esc(e.vsSecond.name)}님보다 종합 <b>${sign(e.vsSecond.totalGap)}점</b> · ${e.vsSecond.parts.map((c) => `${c.label} ${sign(c.gap)}`).join(' · ')}</p>`
          : '<p class="why-vs">지금 조건에서 추천된 사람은 이 한 명이에요</p>'
      }
    </section>`;
}

// 추천이 0명일 때: 왜 0명인지 + 이렇게 바꾸면 몇 명이 추천되는지
function zeroGuide() {
  const reasons = exclusionReasons(me, matches().excluded);
  const { suggestions } = suggestRelaxations(me, pool);
  const theirsFirst = reasons[0]?.side === 'theirs';
  const reasonText = (r) =>
    r.side === 'mine' ? `내가 정한 <b>${r.label}</b> 조건에 맞지 않아요` : `상대가 정한 <b>${r.label}</b> 조건에 내가 맞지 않아요`;
  return `
    <section class="empty guide">
      <div class="flow-emoji" aria-hidden="true">🥲</div>
      <p>지금은 서로 조건이 맞는 사람이 없어요</p>
      ${
        reasons.length
          ? `<div class="guide-block"><h3>왜 0명인가요?</h3>
              <ul class="guide-reasons">${reasons.map((r) => `<li><span>${reasonText(r)}</span><b>${r.count}명</b></li>`).join('')}</ul>
              <p class="hint">한 명이 여러 이유에 해당할 수 있어요.</p></div>`
          : ''
      }
      ${
        suggestions.length
          ? `<div class="guide-block"><h3>이렇게 바꾸면 추천받을 수 있어요</h3>
              <ul class="guide-fixes">${suggestions
                .map(
                  (s) => `<li><span>${esc(s.text)}</span><b>+${s.gain}명</b>
                    <button class="apply-btn" data-relax="${esc(JSON.stringify(s))}">적용</button></li>`,
                )
                .join('')}</ul></div>`
          : `<div class="guide-block"><h3>내 조건을 넓혀도 맞는 사람이 없어요</h3>
              <p class="hint">${theirsFirst ? '대부분 상대가 정한 나이·거리 조건에 맞지 않아서예요. 상대의 조건은 바꿀 수 없어서, 새로운 회원이 가입하면 추천이 생길 수 있어요.' : '조건을 직접 조정해 보세요.'}</p></div>`
      }
      <button class="cta ${suggestions.length ? 'dark' : ''}" data-open="prefs">조건 직접 바꾸기</button>
    </section>`;
}

const RENDERERS = { home: renderHome, ai: renderAi, results: renderResults, inbox: renderInbox, chat: renderChatList, my: renderMy };
const SUB_RENDERERS = { profile: renderProfile, prefs: renderPrefs, interests: renderInterests, values: renderValues, logic: renderLogic };
const TITLES = { home: '', ai: 'AI 매칭', results: '추천 상대', inbox: '매칭 신청함', chat: '채팅', my: '마이페이지' };

function render() {
  // 다시 그려도 넘겨 보던 사진 위치는 유지
  const carouselPos = new Map([...document.querySelectorAll('[data-carousel]')].map((c) => [c.dataset.carousel, c.querySelector('.slides').scrollLeft]));
  renderView();
  for (const c of document.querySelectorAll('[data-carousel]')) {
    const left = carouselPos.get(c.dataset.carousel);
    if (left) {
      c.querySelector('.slides').scrollLeft = left;
      updateDots(c);
    }
  }
  trackViews();
}

function renderView() {
  cache = null;
  // 가입을 마치면 나와 맞는 사람 몇 명이 먼저 신청을 보내고, 한 명은 먼저 말을 건 상태로 시작
  if (me.onboarded && !me.requests.seeded) {
    seedReceived(me.requests, matches().matches);
    save();
  }
  if (me.onboarded && !me.chats.seeded) {
    seedChats(me.chats, me, matches().matches, Date.now(), (id) => !!findRequest(me.requests, id));
    save();
  }
  document.querySelector('#sheet').innerHTML = sheet ? renderSheet() : '';
  document.body.classList.toggle('sheet-open', !!sheet);
  const inFlow = ob !== null || room !== null;
  document.body.classList.toggle('in-flow', inFlow);
  const appbar = document.querySelector('#appbar');
  const tabs = document.querySelector('#tabs');

  if (inFlow) {
    appbar.innerHTML = '';
    tabs.innerHTML = '';
    document.querySelector('#view').innerHTML = room !== null ? renderRoom() : renderOnboarding();
    document.title = room !== null ? `${profileById.get(room).name} · 채팅` : '시작하기 · 가치관 소개팅';
    return;
  }

  const title = sub ? SUBS[sub] : TITLES[tab];
  appbar.innerHTML = sub
    ? `<button class="icon-btn plain" data-back aria-label="뒤로">${icon('back')}</button><h1 class="sub-title">${title}</h1><span class="icon-btn-spacer"></span>`
    : `<div><p class="brand">가치관 소개팅</p>${title ? `<h1>${title}</h1>` : ''}</div>
       <button id="reset" class="icon-btn" aria-label="기본값으로 되돌리기" title="기본값으로 되돌리기"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/></svg></button>`;
  appbar.classList.toggle('is-sub', !!sub);
  document.title = `${title || '홈'} · 가치관 소개팅`;
  const counts = { inbox: [pendingReceivedCount(me.requests), '새 신청'], chat: [unreadTotal(me.chats), '안 읽은 메시지'] };
  tabs.innerHTML = TABS.map((t) => {
    const [n, what] = counts[t.id] ?? [0];
    const badge = n ? `<i class="tab-badge" aria-label="${what} ${n}개">${n}</i>` : '';
    return `<button class="tab ${t.id === tab ? 'active' : ''}" data-tab="${t.id}" ${t.id === tab ? 'aria-current="page"' : ''}><span class="tab-icon">${icon(t.id)}${badge}</span><span>${t.label}</span></button>`;
  }).join('');
  document.querySelector('#view').innerHTML = sub ? SUB_RENDERERS[sub]() : RENDERERS[tab]();
}

const go = () => {
  render();
  window.scrollTo(0, 0);
};

// ---------- 넘기는 사진 ----------
function updateDots(c) {
  const slides = c.querySelector('.slides');
  const i = Math.round(slides.scrollLeft / Math.max(1, slides.clientWidth));
  c.querySelectorAll('.c-dots i').forEach((d, j) => d.classList.toggle('on', j === i));
  c.querySelector('.c-btn.prev')?.toggleAttribute('disabled', i <= 0);
  c.querySelector('.c-btn.next')?.toggleAttribute('disabled', i >= slides.children.length - 1);
}
document.addEventListener('scroll', (e) => e.target.classList?.contains('slides') && updateDots(e.target.closest('[data-carousel]')), true);

// ---------- 프로필 머무는 시간 ----------
// 추천 카드가 60% 이상 보이거나(카드가 화면보다 길면) 화면의 절반 이상을 채우는 동안을 잼.
// 다시 그려도 같은 카드는 이어서 잼
const viewing = new Map(); // id → 보기 시작한 시각
const isViewed = (e) =>
  e.isIntersecting && e.intersectionRect.height >= Math.min(e.boundingClientRect.height * 0.6, window.innerHeight * 0.5);
function endView(id) {
  const start = viewing.get(id);
  if (start == null) return;
  viewing.delete(id);
  recordView(me.views, id, performance.now() - start);
  save();
}
const viewObserver = new IntersectionObserver(
  (entries) => {
    for (const e of entries) {
      const id = e.target.dataset.viewId;
      if (isViewed(e)) {
        if (!viewing.has(id)) viewing.set(id, performance.now());
      } else endView(id);
    }
  },
  { threshold: Array.from({ length: 21 }, (_, i) => i / 20) },
);
function trackViews() {
  viewObserver.disconnect();
  const cards = [...document.querySelectorAll('[data-view-id]')];
  const present = new Set(cards.map((c) => c.dataset.viewId));
  for (const id of [...viewing.keys()]) if (!present.has(id)) endView(id);
  cards.forEach((c) => viewObserver.observe(c));
}
document.addEventListener('visibilitychange', () => {
  if (document.hidden) [...viewing.keys()].forEach(endView);
  else trackViews();
});

// ---------- 프로필 사진 ----------
async function addPhotos(files) {
  const free = MAX_PHOTOS - photos.length;
  const images = [...files].filter((f) => f.type.startsWith('image/'));
  if (!images.length) return showToast('사진 파일만 올릴 수 있어요');
  if (images.length > free) showToast(`최대 ${MAX_PHOTOS}장까지라 ${free}장만 추가했어요`);
  const next = [...photos];
  for (const file of images.slice(0, free)) {
    try {
      next.push(await resizeImage(file));
    } catch {
      showToast('열 수 없는 사진이 있어서 건너뛰었어요');
    }
  }
  if (!savePhotos(next)) return showToast('저장 공간이 부족해서 사진을 저장하지 못했어요');
  photos = next;
  render();
}

const findMatch = (id) => matchPair(me, profileById.get(id));

// ---------- AI 매칭 (로컬 LLM) ----------
// 1) 서로의 "반드시" 조건을 통과한 이성만 후보로 → 2) 나와 후보들의 특징을 글로 리스트업
// 3) server.js → Ollama: LLM이 특징을 읽고 가장 잘 맞는 상대를 직접 골라 이유를 씀 (점수 계산 없음)
// 4) 매칭이 성사되면 LLM이 두 사람이 왜 매칭됐는지 설명
const llm = { checked: false, ok: false, model: '', error: '' };
let aiJob = null; // 지금 돌고 있는 LLM 작업 (CPU라 한 번에 하나만) { kind: 'match' | 'explain', id, abort, phase, step, steps, size, startedAt }
const explaining = new Map(); // 상대 id → 만들고 있는 설명 { text }

async function checkLlm() {
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
  try {
    const r = await fetch('api/llm/status', { cache: 'no-store' });
    Object.assign(llm, await r.json());
  } catch {
    Object.assign(llm, {
      ok: false,
      error: local ? '서버에 연결할 수 없어요. npm start로 실행해 주세요.' : '배포 사이트에서는 로컬 LLM을 쓸 수 없어요. 내 컴퓨터에서 npm start로 실행하면 쓸 수 있어요.',
    });
  }
  llm.checked = true;
  if (!aiJob && !sheet && !typing()) render();
}

const llmLabel = () =>
  !llm.checked ? '로컬 LLM 확인 중…' : llm.ok ? `로컬 LLM · ${esc(llm.model)}` : 'LLM 연결 안 됨 · 규칙 기반으로 대신해요';

const aiText = (text) =>
  esc(text)
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => `<p>${l}</p>`)
    .join('');

const isMatched = (id) => findRequest(me.requests, id)?.status === 'accepted';
const aiPickOf = (id) => me.ai?.picks?.find((p) => p.id === id);
const sigOf = (s) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7).toString(36);
const secs = (ms) => `${Math.max(1, Math.round((ms ?? 0) / 1000))}초`;

// AI 매칭 입력: 후보와 "내 특징 + 후보 명단" 서명 (프로필이 바뀌면 다시 매칭하라고 알려 주려고)
function aiInput() {
  const cands = aiCandidates(me, pool);
  return { cands, sig: sigOf(JSON.stringify([myTraits(me), cands.map((c) => c.profile.id)])) };
}

// 예선·결선을 합쳐 LLM에 몇 번 물어보는지
function stepsFor(n) {
  let steps = 0;
  while (n > BATCH_SIZE) {
    const groups = Math.ceil(n / BATCH_SIZE);
    steps += groups;
    n = groups * 2;
  }
  return steps + 1;
}

// 서버의 한 줄 JSON 스트림 읽기
async function streamApi(path, body, signal, onMsg) {
  const r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `서버 응답 ${r.status}`);
  const reader = r.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const msg = JSON.parse(buf.slice(0, i));
      buf = buf.slice(i + 1);
      if (msg.error) throw new Error(msg.error);
      onMsg(msg);
    }
  }
}

// 후보 한 조(최대 8명)를 LLM에 보여 주고 pick명을 고르게 함
async function askPick(group, pick, step) {
  Object.assign(aiJob, { step, phase: 'read', size: group.length, stepStart: Date.now() });
  updateAim();
  let picks = null;
  const body = {
    me: myTraits(me),
    meName: callName(me.name),
    candidates: group.map((c) => ({ text: traitsOf(c.profile, { distance: c.distance, me }) })),
    pick,
  };
  await streamApi('api/ai-match', body, aiJob.abort.signal, (msg) => {
    if (msg.phase) {
      aiJob.phase = msg.phase;
      updateAim();
    }
    if (msg.done) picks = msg.picks;
  });
  if (!picks?.length) throw new Error('AI 답이 비어 있어요');
  // 서버는 후보를 보낸 순서대로 A, B, C… 로 부름
  return picks.map((p) => ({ cand: group[LABELS.indexOf(p.id)], reason: p.reason })).filter((p) => p.cand);
}

async function runAiMatch() {
  if (aiJob) return showToast('AI가 다른 일을 하는 중이에요. 끝나면 다시 눌러 주세요');
  const { cands, sig } = aiInput();
  if (!cands.length) return showToast('서로 조건이 맞는 상대가 없어요. 원하는 조건을 넓혀 보세요');
  const base = { at: Date.now(), sig, total: cands.length };

  if (!llm.ok) {
    me.ai = { ...base, picks: fallbackPicks(me, cands), source: 'rule' };
    save();
    return render();
  }

  const abort = new AbortController();
  aiJob = { kind: 'match', abort, phase: 'read', step: 1, steps: stepsFor(cands.length), size: cands.length, startedAt: Date.now() };
  render();
  try {
    let list = cands;
    let step = 0;
    // 후보가 많으면 예선: 조마다 2명씩 올려 결선 진출자를 뽑음
    while (list.length > BATCH_SIZE) {
      const next = [];
      for (const group of splitGroups(list)) next.push(...(await askPick(group, 2, ++step)).map((p) => p.cand));
      list = next;
    }
    const final = await askPick(list, Math.min(PICK_COUNT, list.length), ++step);
    me.ai = { ...base, picks: final.map((p) => ({ id: p.cand.profile.id, reason: p.reason })), source: 'llm', model: llm.model, ms: Date.now() - aiJob.startedAt, rounds: step };
    showToast('🤖 AI가 매칭 상대를 골랐어요');
  } catch (e) {
    if (!abort.signal.aborted) me.ai = { ...base, picks: fallbackPicks(me, cands), source: 'rule', note: `${e.message} 그래서 규칙으로 대신 골랐어요.` };
  } finally {
    aiJob = null;
    save();
    render();
  }
}

// 진행 상황 · 시작 버튼 상자
function aimBox() {
  const { cands, sig } = aiInput();
  let body;
  if (aiJob?.kind === 'match') {
    const j = aiJob;
    const stage = j.steps > 1 ? (j.step < j.steps ? `예선 ${j.step}/${j.steps - 1}조` : '결선') : '';
    const what = j.phase === 'read' ? `후보 ${j.size}명의 특징을 읽고 비교하는 중…` : '고른 상대와 이유를 쓰는 중…';
    body = `
      <p class="aim-now">🤖 ${stage ? `<b>${stage}</b> · ` : ''}${what}</p>
      <div class="aim-progress" aria-hidden="true"><div></div></div>
      <p class="hint">${secs(Date.now() - j.startedAt)} 지남 · 내 컴퓨터 CPU에서 돌아가서 1~3분 걸릴 수 있어요</p>
      <button class="ai-btn ghost-sm" data-ai-stop>그만하기</button>`;
  } else if (!cands.length) {
    body = `<p>서로 반드시 조건이 맞는 상대가 없어서 AI에게 보여 줄 후보가 없어요.</p>
      <button class="ai-btn" data-open="prefs">원하는 조건 넓히기</button>`;
  } else {
    const stale = me.ai && me.ai.sig !== sig;
    body = `
      ${!llm.ok && llm.checked ? `<p class="hint warn">${esc(llm.error)}</p>` : ''}
      ${stale ? '<p class="hint warn">프로필이나 조건이 바뀌었어요. 다시 매칭하면 바뀐 내용으로 골라요.</p>' : ''}
      <button class="ai-btn" data-ai-match>${llm.ok || !llm.checked ? (me.ai ? '🤖 AI 매칭 다시 하기' : '🤖 AI 매칭 시작') : '📝 규칙으로 대신 고르기'}</button>`;
  }
  return `<section class="ai-box aim-box" data-aim-box>
    <div class="ai-head"><b>🤖 LLM 매칭</b><small>${llmLabel()}</small></div>${body}</section>`;
}

const updateAim = () => {
  const el = document.querySelector('[data-aim-box]');
  if (el) el.outerHTML = aimBox();
};

// LLM에게 보내는 특징 목록 (리스트업)
function traitsSection(cands) {
  if (!cands.length) return '';
  const shown = cands.length <= BATCH_SIZE;
  return `
    <details class="more aim-traits">
      <summary>📋 LLM에게 보내는 특징 목록 보기 (나 + 후보 ${cands.length}명)</summary>
      <p class="hint">이 글이 그대로 LLM에 들어가요. 후보 순서는 추천 점수와 상관없이 섞었어요.${shown ? '' : ` 후보가 많아서 ${BATCH_SIZE}명씩 나눠 보여 줘요.`}</p>
      <h3>나</h3><pre class="traits">${esc(myTraits(me))}</pre>
      <h3>후보</h3>
      ${cands.map((c, i) => `<pre class="traits">${esc(traitsOf(c.profile, { label: shown ? LABELS[i] : '', distance: c.distance, me }))}</pre>`).join('')}
    </details>`;
}

// AI가 고른 상대 카드
function pickCard(pick, i) {
  const p = profileById.get(pick.id);
  if (!p || p.gender === me.gender) return '';
  const m = matchPair(me, p);
  const medal = ['🥇', '🥈', '🥉'][i] ?? `${i + 1}위`;
  return `
    <article class="card aim-pick">
      <header class="match-head">
        ${avatarEl(p)}
        <div class="match-who">
          <h2><span class="aim-medal">${medal}</span> ${esc(p.name)} <span>${p.age}</span></h2>
          <p>${esc(p.job)} · ${p.region} · ${Math.round(m.distance)}km</p>
        </div>
      </header>
      <p class="aim-reason"><b>${me.ai.source === 'rule' ? '📝 규칙으로 고른 이유' : '🤖 AI가 고른 이유'}</b>${esc(pick.reason)}</p>
      <div class="chips static">${p.interests.map((t) => `<span class="tag ${me.interests.includes(t) ? 'accent' : ''}">${t}</span>`).join('')}</div>
      ${isMatched(p.id) ? explainBlock(p.id) : '<p class="hint aim-next">💌 매칭을 신청해서 성사되면, AI가 두 사람이 왜 잘 맞는지 자세히 설명해 드려요.</p>'}
      <div class="card-actions">${chatAction(p)}${requestAction(p)}</div>
    </article>`;
}

function pickList() {
  const a = me.ai;
  return `
    <section class="group">
      <h2 class="group-title">${a.source === 'rule' ? '📝 규칙으로 고른 상대' : '🤖 AI가 고른 상대'}</h2>
      <p class="group-desc">${a.source === 'llm' ? `${esc(a.model)}가 후보 ${a.total}명의 특징을 읽고 골랐어요 · ${secs(a.ms)}` : `LLM 없이 추천 점수 순으로 골랐어요 · 후보 ${a.total}명`}</p>
      ${a.note ? `<p class="hint warn aim-note">${esc(a.note)}</p>` : ''}
      ${a.picks.map(pickCard).join('')}
    </section>`;
}

// AI가 고르지 않았어도, 신청이 승인된 상대는 모두 설명을 들을 수 있음
function matchedSection() {
  const ids = [...new Set([...me.requests.sent, ...me.requests.received].filter((r) => r.status === 'accepted').map((r) => r.id))].filter(
    (id) => !aiPickOf(id) && profileById.has(id),
  );
  if (!ids.length) return '';
  return `
    <section class="group">
      <h2 class="group-title">💞 성사된 매칭</h2>
      <p class="group-desc">서로 승인한 상대예요. AI에게 왜 매칭됐는지 물어보세요.</p>
      ${ids
        .map((id) => {
          const p = profileById.get(id);
          return `<article class="card aim-pick">
            <header class="match-head">${avatarEl(p)}<div class="match-who"><h2>${esc(p.name)} <span>${p.age}</span></h2><p>${esc(p.job)} · ${p.region}</p></div></header>
            ${explainBlock(id)}
            <div class="card-actions">${chatAction(p)}${requestAction(p)}</div>
          </article>`;
        })
        .join('')}
    </section>`;
}

function renderAi() {
  if (!me.onboarded) {
    return `<section class="empty"><div class="flow-emoji" aria-hidden="true">🤖</div><p>가입을 마치면 AI가 매칭 상대를 골라 드려요</p>
      <p class="hint">프로필, 자기소개, 가치관을 LLM이 읽고 판단해요.</p><button class="cta" data-ob-start>1분 만에 시작하기</button></section>`;
  }
  const { cands } = aiInput();
  const opposite = pool.filter((p) => p.gender !== me.gender).length;
  return `
    <section class="hero aim-hero">
      <p>점수 계산 없이, LLM이 직접 판단해요</p>
      <h2>특징을 읽고 고르는<br><em>AI 매칭</em></h2>
      <ol class="aim-steps">
        <li><b>1</b><span>이성 ${opposite}명 중 서로의 <u>반드시 조건</u>을 통과한 <strong>${cands.length}명</strong>이 후보</span></li>
        <li><b>2</b><span>나와 후보의 특징(자기소개·관심사·가치관·바라는 점)을 글로 리스트업</span></li>
        <li><b>3</b><span>로컬 LLM이 읽고 가장 잘 맞는 <strong>${Math.min(PICK_COUNT, cands.length)}명</strong>을 골라 이유를 써요${cands.length > BATCH_SIZE ? ` (${BATCH_SIZE}명씩 예선 → 결선)` : ''}</span></li>
        <li><b>4</b><span>매칭이 성사되면 두 사람이 왜 매칭됐는지 설명해요</span></li>
      </ol>
    </section>
    ${aimBox()}
    ${traitsSection(cands)}
    ${me.ai ? pickList() : ''}
    ${matchedSection()}`;
}

// ---------- 매칭 성사 후 AI 설명 ----------
function explainBlock(id) {
  const saved = me.aiExplain?.[id];
  const live = explaining.get(id);
  const p = profileById.get(id);
  const source = live || !saved ? llmLabel() : saved.source === 'llm' ? `로컬 LLM · ${esc(saved.model ?? '')}` : 'LLM 대신 규칙으로 만든 설명';
  const head = `<div class="ai-head"><b>💞 왜 매칭됐을까?</b><small>${source}</small></div>`;
  let body;
  if (live) {
    body = `<div class="ai-text loading" aria-live="polite">${live.text ? aiText(live.text) : '<p class="hint">AI가 두 사람의 특징을 읽고 있어요… 내 컴퓨터에서 돌아가서 1분 정도 걸릴 수 있어요.</p>'}<span class="caret" aria-hidden="true"></span></div>
      <button class="ai-btn ghost-sm" data-ai-stop>그만 만들기</button>`;
  } else if (saved) {
    body = `<div class="ai-text">${aiText(saved.text)}</div>
      ${saved.note ? `<p class="hint warn">${esc(saved.note)}</p>` : ''}
      <div class="ai-foot"><small>${saved.source === 'llm' ? `${esc(saved.model ?? '')} · ${secs(saved.ms)} · ` : ''}두 사람의 프로필에 적힌 내용만 썼어요</small>
      <button class="link-btn" data-explain="${id}">다시 만들기</button></div>`;
  } else {
    body = `<p class="hint">${esc(p?.name ?? '')}님과 매칭이 성사됐어요! AI가 두 사람의 특징을 읽고 왜 잘 맞는지 설명해 드려요.</p>
      <button class="ai-btn" data-explain="${id}">${llm.ok || !llm.checked ? '✨ 매칭 이유 AI 설명 듣기' : '📝 규칙 기반 설명 보기'}</button>`;
  }
  return `<section class="ai-box ${live ? 'loading' : ''}" data-ai-box="${id}">${head}${body}</section>`;
}

// 화면 전체를 다시 그리지 않고 설명 상자만 갱신 (사진 넘기던 위치 등이 유지되도록)
function updateAi(id) {
  document.querySelectorAll(`[data-ai-box="${CSS.escape(id)}"]`).forEach((box) => (box.outerHTML = explainBlock(id)));
}

async function runExplain(id) {
  if (aiJob) return showToast(aiJob.kind === 'match' ? 'AI가 매칭 상대를 고르는 중이에요. 끝나면 다시 눌러 주세요' : '다른 설명을 만드는 중이에요. 끝나면 다시 눌러 주세요');
  const p = profileById.get(id);
  if (!p) return;
  const reason = aiPickOf(id)?.reason ?? '';
  const rule = (note) => ({ text: fallbackMatchExplanation(me, p, reason), source: 'rule', note, at: Date.now() });
  if (!llm.ok) {
    me.aiExplain[id] = rule();
    save();
    return updateAi(id);
  }

  const abort = new AbortController();
  aiJob = { kind: 'explain', id, abort, startedAt: Date.now() };
  const live = { text: '' };
  explaining.set(id, live);
  updateAi(id);
  let pending = null; // 글자가 올 때마다 그리면 무거워서 화면 갱신은 한 박자에 한 번
  const paint = () => (pending ??= setTimeout(() => ((pending = null), updateAi(id)), 80));
  let ms = null;
  try {
    const facts = explainFacts(me, p, { distance: matchPair(me, p).distance, reason });
    await streamApi('api/match-explain', facts, abort.signal, (msg) => {
      if (msg.t) {
        live.text += msg.t;
        paint();
      }
      if (msg.done) ms = msg.ms;
    });
    if (!live.text.trim()) throw new Error('AI가 빈 답을 보냈어요.');
    me.aiExplain[id] = { text: live.text.trim(), source: 'llm', model: llm.model, ms, at: Date.now() };
  } catch (e) {
    if (!abort.signal.aborted) me.aiExplain[id] = rule(`${e.message} 대신 규칙으로 만든 설명을 보여드려요.`);
    else if (live.text.trim()) me.aiExplain[id] = { text: live.text.trim(), source: 'llm', model: llm.model, ms: Date.now() - aiJob.startedAt, note: '설명을 중간에 멈췄어요.', at: Date.now() };
  } finally {
    clearTimeout(pending);
    explaining.delete(id);
    aiJob = null;
    save();
    updateAi(id);
  }
}

// 자기소개 입력칸 (가입 단계와 내 프로필에서 같이 씀)
const selfIntroInput = () =>
  `<textarea class="intro-input" data-path="selfIntro" maxlength="150" rows="4" placeholder="예: 주말엔 카페에서 책 읽는 걸 좋아해요. 대화가 잘 통하는 사람을 만나고 싶어요." aria-label="자기소개">${esc(me.selfIntro ?? '')}</textarea>
   <p class="hint">150자까지 · 나를 잘 보여 주는 취미, 성격, 바라는 연애를 적어 보세요</p>`;

// 확인 창의 "신청하기/승인하기"
function confirmSheet() {
  const input = document.querySelector('#sheet-kakao');
  if (input) {
    const value = input.value.trim();
    if (!KAKAO_ID.test(value)) {
      sheet.error = '영문, 숫자, . _ - 로 4~20자를 입력해 주세요';
      return render();
    }
    me.kakaoId = value;
  }
  const p = profileById.get(sheet.id);
  if (sheet.type === 'accept') {
    respond(me.requests, p.id, true);
    showToast(`🎉 ${p.name}님과 매칭됐어요! 카카오 ID를 확인해 보세요`);
  } else {
    sendRequest(me.requests, findMatch(p.id));
    showToast(`💌 ${p.name}님에게 매칭을 신청했어요`);
  }
  sheet = null;
  save();
  render();
}

// ---------- 이벤트 ----------
document.addEventListener('click', (e) => {
  const hit = (sel) => e.target.closest(sel);
  let el;
  if (hit('[data-sheet-close]')) {
    sheet = null;
    return render();
  }
  if (hit('[data-sheet-confirm]')) return confirmSheet();
  if (hit('[data-ai-match]')) return runAiMatch();
  if ((el = hit('[data-explain]'))) return runExplain(el.dataset.explain);
  if (hit('[data-ai-stop]')) return aiJob?.abort.abort();
  if ((el = hit('[data-c-move]'))) {
    const slides = el.closest('[data-carousel]').querySelector('.slides');
    slides.scrollBy({ left: Number(el.dataset.cMove) * slides.clientWidth, behavior: 'smooth' });
    return;
  }
  if ((el = hit('[data-photo-del]'))) {
    photos = photos.filter((_, i) => i !== Number(el.dataset.photoDel));
    savePhotos(photos);
    return render();
  }
  if ((el = hit('[data-photo-main]'))) {
    const i = Number(el.dataset.photoMain);
    photos = [photos[i], ...photos.filter((_, j) => j !== i)];
    savePhotos(photos);
    showToast('대표 사진으로 바꿨어요');
    return render();
  }
  if ((el = hit('[data-room]'))) return openRoom(el.dataset.room);
  if (hit('[data-room-close]')) {
    room = null;
    tab = 'chat';
    sub = null;
    return go();
  }
  if ((el = hit('[data-ice]'))) {
    const input = document.querySelector('#chat-input');
    input.value = el.dataset.ice;
    input.focus();
    return;
  }
  if ((el = hit('[data-relax]'))) {
    const r = JSON.parse(el.dataset.relax);
    applyRelaxation(me, r);
    save();
    showToast(`조건을 바꿨어요 · ${r.count}명이 추천돼요`);
    return go();
  }
  if ((el = hit('[data-req-open]'))) {
    sheet = { type: 'request', id: el.dataset.reqOpen };
    return render();
  }
  if ((el = hit('[data-accept]'))) {
    sheet = { type: 'accept', id: el.dataset.accept };
    return render();
  }
  if ((el = hit('[data-reject]'))) {
    const p = profileById.get(el.dataset.reject);
    if (!confirm(`${p.name}님의 신청을 거절할까요?`)) return;
    respond(me.requests, p.id, false);
    save();
    showToast('신청을 거절했어요');
    return render();
  }
  if ((el = hit('[data-cancel]'))) {
    cancelRequest(me.requests, el.dataset.cancel);
    save();
    showToast('신청을 취소했어요');
    return render();
  }
  if ((el = hit('[data-copy]'))) {
    navigator.clipboard?.writeText(el.dataset.copy).then(
      () => showToast('카카오 ID를 복사했어요'),
      () => showToast('복사하지 못했어요. 길게 눌러 직접 복사해 주세요'),
    );
    return;
  }
  if ((el = hit('[data-inbox]'))) {
    tab = 'inbox';
    sub = null;
    inboxTab = el.dataset.inbox;
    return go();
  }
  if ((el = hit('[data-tab]'))) {
    tab = el.dataset.tab;
    sub = null;
    return go();
  }
  if ((el = hit('[data-open]'))) {
    tab = 'my';
    sub = el.dataset.open;
    return go();
  }
  if (hit('[data-back]')) {
    sub = null;
    return go();
  }
  if (hit('[data-ob-start]')) {
    ob = 0;
    return go();
  }
  if ((el = hit('[data-ob]'))) {
    ob = Math.min(OB_STEPS.length - 1, Math.max(0, ob + Number(el.dataset.ob)));
    return go();
  }
  if (hit('[data-ob-exit]')) {
    ob = null;
    return go();
  }
  if (hit('[data-ob-done]')) {
    ob = null;
    tab = 'my';
    sub = 'values';
    qIndex = 0;
    return go();
  }
  if (hit('[data-values-done]')) {
    me.onboarded = true;
    save();
    tab = 'results';
    sub = null;
    return go();
  }
  if ((el = hit('[data-q]'))) {
    qIndex = Number(el.dataset.q);
    return go();
  }
  if ((el = hit('[data-step]'))) {
    qIndex = Math.min(VALUE_QUESTIONS.length - 1, Math.max(0, qIndex + Number(el.dataset.step)));
    return go();
  }
  if (hit('#reset') && confirm('입력한 내용, 프로필 사진, 신청·채팅 기록을 모두 지우고 기본값으로 되돌릴까요?')) {
    me = { ...defaultMe(), ...freshState() };
    photos = [];
    savePhotos(photos);
    viewing.clear();
    save();
    tab = 'home';
    sub = null;
    go();
  }
});

document.addEventListener('submit', (e) => {
  if (!e.target.matches('[data-chat-form]')) return;
  e.preventDefault();
  const input = document.querySelector('#chat-input');
  submitChat(input.value);
  input.value = '';
  input.focus();
});

document.addEventListener('change', (e) => {
  const el = e.target;
  if (el.hasAttribute?.('data-photo-input')) {
    addPhotos(el.files);
    return;
  }
  if (el.hasAttribute?.('data-logic-filter')) {
    logicFilter = el.dataset.logicFilter;
    return render();
  }
  if (el.hasAttribute?.('data-inbox-tab')) {
    inboxTab = el.dataset.inboxTab;
    return render();
  }
  if (el.hasAttribute?.('data-sido')) {
    const g = REGION_GROUPS.find((g) => g.sido === el.value);
    me.region = `${g.sido} ${g.districts[0][0]}`;
    save();
    return render();
  }
  const path = el.dataset?.path;
  if (!path) return;
  const parse = (v) => (el.hasAttribute('data-num') ? Number(v) : v);

  if (el.hasAttribute('data-multi')) {
    const values = [...document.querySelectorAll('input[data-multi]')]
      .filter((i) => i.dataset.path === path && i.checked)
      .map((i) => parse(i.value));
    setPath(me, path, values);
  } else if (el.hasAttribute('data-bool')) {
    setPath(me, path, el.checked);
  } else {
    setPath(me, path, parse(el.value));
  }
  // 매우 중요가 아니면 '절대 안 됨'도 해제
  const importance = path.match(/^values\.(\w+)\.importance$/);
  if (importance && me.values[importance[1]].importance !== 50) me.values[importance[1]].dealbreaker = false;

  if (path === 'gender') {
    const keep = { ageMin: me.prefs.ageMin, ageMax: me.prefs.ageMax, maxDistance: me.prefs.maxDistance };
    me.prefs = { ...defaultPrefs(partnerOf(me.gender)), ...keep };
    me.appearance = Object.fromEntries(appearanceFor(me.gender).map((a) => [a.key, a.options[0]]));
    Object.assign(me, freshState()); // 추천 상대가 모두 바뀌므로 신청·채팅·조회 기록도 새로 시작
  }
  save();
  render();
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && sheet) {
    sheet = null;
    render();
  }
  // 채팅: Enter로 보내기, Shift+Enter는 줄바꿈 (한글 조합 중에는 보내지 않음)
  if (e.target.id === 'chat-input' && e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    e.target.form.requestSubmit();
  }
});

// 1초마다: 채팅 답장 확인 · 5초마다: 보낸 신청 응답 확인 · 30초마다: 남은 공개 시간 갱신
const typing = () => document.activeElement?.matches?.('input[type="text"], input[type="number"], textarea, select');
const matchById = (id) => (profileById.has(id) ? matchPair(me, profileById.get(id)) : null);
let ticks = 0;
setInterval(() => {
  ticks++;
  const arrived = resolveReplies(me.chats, me, matchById, Date.now(), room);
  const decided = ticks % 5 === 0 ? resolveDue(me.requests) : [];
  if (arrived.length || decided.length) save();
  for (const { room: r, msg } of arrived) {
    if (r.id !== room) showToast(`💬 ${profileById.get(r.id).name}: ${msg.text.slice(0, 30)}`);
  }
  for (const r of decided) {
    const p = profileById.get(r.id);
    showToast(r.status === 'accepted' ? `🎉 ${p.name}님이 매칭을 승인했어요! AI 매칭 탭에서 매칭 이유를 들어 보세요` : `${p.name}님이 이번 매칭은 어렵다고 했어요`);
  }
  if (aiJob?.kind === 'match') updateAim();
  // 채팅방 안에서는 입력 중인 글이 지워지지 않게 메시지 목록만 갱신
  if (room !== null) {
    if (arrived.some((a) => a.room.id === room) || (ticks % 30 === 0)) refreshChatLog();
    return;
  }
  const refreshCountdown = tab === 'inbox' && ticks % 30 === 0;
  if ((arrived.length || decided.length || refreshCountdown) && !typing() && !sheet && ob === null) render();
}, 1000);

resolveDue(me.requests);
render();
checkLlm();
