// 매칭 신청: 대기(pending) → 승인(accepted) / 거절(rejected), 승인 시 72시간 동안 카카오 ID 공개
// 서버가 없는 프로토타입이라 샘플 회원의 응답은 여기서 흉내 냄

export const REVEAL_MS = 72 * 60 * 60 * 1000;
// 체험용: 샘플 회원은 20~60초 뒤에 응답
export const REPLY_DELAY_MS = { min: 20_000, max: 60_000 };

export const STATUS_LABEL = { pending: '대기 중', accepted: '승인', rejected: '거절' };

export const emptyRequests = () => ({ sent: [], received: [], seeded: false });

// 샘플 회원의 카카오 ID. 실제 ID와 겹치지 않도록 demo- 접두어 사용
export const demoKakaoId = (profile) => `demo-${profile.id}`;

const hash = (s) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);

// 상대가 나를 얼마나 마음에 들어 하는지(bToA)로 승인 여부를 정함. 같은 사람은 항상 같은 결과
export function decideReply(match) {
  const id = match.profile.id;
  const luck = (hash(id) % 25) / 100; // 0~0.24
  const willAccept = match.values.bToA + luck >= 0.6;
  const delay = REPLY_DELAY_MS.min + (hash(id + 'delay') % (REPLY_DELAY_MS.max - REPLY_DELAY_MS.min));
  return { willAccept, delay };
}

export function findRequest(store, profileId) {
  return (
    store.sent.find((r) => r.id === profileId && r.status !== 'cancelled') ??
    store.received.find((r) => r.id === profileId) ??
    null
  );
}

export function sendRequest(store, match, now = Date.now()) {
  if (findRequest(store, match.profile.id)) return store; // 한 사람에게 한 번만
  const { willAccept, delay } = decideReply(match);
  store.sent.unshift({ id: match.profile.id, dir: 'sent', status: 'pending', at: now, respondAt: now + delay, willAccept });
  return store;
}

export function cancelRequest(store, profileId) {
  store.sent = store.sent.filter((r) => !(r.id === profileId && r.status === 'pending'));
  return store;
}

export function respond(store, profileId, accept, now = Date.now()) {
  const req = store.received.find((r) => r.id === profileId && r.status === 'pending');
  if (req) {
    req.status = accept ? 'accepted' : 'rejected';
    req.decidedAt = now;
  }
  return store;
}

// 응답 시간이 지난 보낸 신청을 처리하고, 새로 결정된 신청 목록을 돌려줌
export function resolveDue(store, now = Date.now()) {
  const decided = [];
  for (const r of store.sent) {
    if (r.status === 'pending' && r.respondAt <= now) {
      r.status = r.willAccept ? 'accepted' : 'rejected';
      r.decidedAt = r.respondAt;
      decided.push(r);
    }
  }
  return decided;
}

// 나와 서로 조건이 맞는 사람 중, 나를 가장 마음에 들어 할 사람들이 먼저 신청을 보낸 것으로 시작
export function seedReceived(store, matches, now = Date.now(), count = 3) {
  if (store.seeded) return store;
  const candidates = matches
    .filter((m) => !findRequest(store, m.profile.id))
    .sort((a, b) => b.values.bToA - a.values.bToA)
    .slice(0, count);
  candidates.forEach((m, i) => {
    store.received.push({ id: m.profile.id, dir: 'received', status: 'pending', at: now - (i + 1) * 17 * 60_000 });
  });
  store.seeded = true;
  return store;
}

export function revealInfo(req, now = Date.now()) {
  if (req?.status !== 'accepted') return { visible: false, remainingMs: 0, expired: false };
  const remainingMs = req.decidedAt + REVEAL_MS - now;
  return { visible: remainingMs > 0, remainingMs: Math.max(0, remainingMs), expired: remainingMs <= 0 };
}

export const pendingReceivedCount = (store) => store.received.filter((r) => r.status === 'pending').length;

export function timeAgo(at, now = Date.now()) {
  const m = Math.floor((now - at) / 60_000);
  if (m < 1) return '방금';
  if (m < 60) return `${m}분 전`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}시간 전`;
  return `${Math.floor(h / 24)}일 전`;
}

export function formatRemaining(ms) {
  const totalMin = Math.ceil(ms / 60_000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return h > 0 ? `${h}시간 ${m}분 남음` : `${m}분 남음`;
}
