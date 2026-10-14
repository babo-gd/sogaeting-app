// 프로필 머무는 시간: 여러 번 봤거나 오래 본 프로필을 다시 추천
export const VIEW_RULES = {
  minVisibleMs: 1000, // 이보다 짧게 스쳐 지나간 건 본 걸로 치지 않음
  interestedCount: 3, // 3번 이상 봤거나
  interestedMs: 15_000, // 합쳐서 15초 이상 봤으면 관심 상대
};

export const emptyViews = () => ({});

export function recordView(views, id, ms, now = Date.now()) {
  if (ms < VIEW_RULES.minVisibleMs) return views;
  const v = (views[id] ??= { count: 0, ms: 0, last: 0 });
  v.count += 1;
  v.ms += Math.round(ms);
  v.last = now;
  return views;
}

export const isInterested = (v) => !!v && (v.count >= VIEW_RULES.interestedCount || v.ms >= VIEW_RULES.interestedMs);

// 0~1: 본 횟수와 본 시간을 절반씩 반영
export const interestScore = (v) => (v ? 0.5 * Math.min(1, v.count / 5) + 0.5 * Math.min(1, v.ms / 30_000) : 0);

export function viewSummary(v) {
  const sec = Math.round(v.ms / 1000);
  const time = sec >= 60 ? `${Math.floor(sec / 60)}분 ${sec % 60}초` : `${sec}초`;
  return `${v.count}번 · 총 ${time} 봤어요`;
}

// 지금 서로 추천되는 사람 중 관심 있게 본 사람. skip(id)이 true면 이미 연락 중이라 제외
export function interestedMatches(views, matches, skip = () => false) {
  return matches
    .filter((m) => isInterested(views[m.profile.id]) && !skip(m.profile.id))
    .map((m) => ({ match: m, view: views[m.profile.id] }))
    .sort((a, b) => interestScore(b.view) - interestScore(a.view) || b.match.total - a.match.total);
}
