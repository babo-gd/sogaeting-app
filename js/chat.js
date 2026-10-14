// 채팅: 서로 추천된 사이에서 둘 중 한 명이 먼저 메시지를 보내면 채팅방이 생김
// 서버가 없는 프로토타입이라 샘플 회원의 답장은 여기서 흉내 냄
import { topDimensions } from './matching.js';

export const MAX_MESSAGE = 500;
export const REPLY_DELAY_MS = { min: 2500, max: 6000 };

export const emptyChats = () => ({ rooms: {}, seeded: false });

const hash = (s) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
const pick = (arr, seed) => arr[hash(seed) % arr.length];

export const getRoom = (chats, id) => chats.rooms[id] ?? null;

function createRoom(chats, id, startedBy, now) {
  return (chats.rooms[id] ??= { id, startedBy, createdAt: now, messages: [], unread: 0, replyAt: null });
}

// 내가 보내기: 채팅방이 없으면 이때 생성. 상대 답장을 예약
export function sendMessage(chats, id, text, now = Date.now()) {
  const body = String(text).trim().slice(0, MAX_MESSAGE);
  if (!body) return null;
  const room = createRoom(chats, id, 'me', now);
  room.messages.push({ from: 'me', text: body, at: now });
  if (!room.replyAt) {
    const span = REPLY_DELAY_MS.max - REPLY_DELAY_MS.min;
    room.replyAt = now + REPLY_DELAY_MS.min + (hash(id + room.messages.length) % span);
  }
  return room;
}

export function markRead(chats, id) {
  const room = chats.rooms[id];
  if (room) room.unread = 0;
}

export const unreadTotal = (chats) => Object.values(chats.rooms).reduce((s, r) => s + (r.unread || 0), 0);

export function sortedRooms(chats) {
  const lastAt = (r) => r.messages.at(-1)?.at ?? r.createdAt;
  return Object.values(chats.rooms).sort((a, b) => lastAt(b) - lastAt(a));
}

// ---------- 샘플 회원의 말 ----------
function topics(me, match) {
  const p = match.profile;
  const shared = match.interests.shared;
  const interest = shared[0] ?? p.interests[0];
  const myInterest = me.interests.find((i) => !shared.includes(i)) ?? me.interests[0];
  const tendency = topDimensions(p.interests)[0];
  const agree = match.values.details.find((d) => d.iLike && d.theyLike && d.myImportance >= 10);
  return { p, shared, interest, myInterest, tendency, agree };
}

// 채팅방이 비어 있을 때 보여줄 첫 마디 추천
export function icebreakers(me, match) {
  const t = topics(me, match);
  const list = [];
  if (t.shared.length) list.push(`안녕하세요! 저도 ${t.shared[0]} 좋아해요 😊 요즘도 자주 하세요?`);
  else if (t.interest) list.push(`안녕하세요! ${t.interest} 좋아하신다고 봤어요. 어떤 점이 좋으세요?`);
  if (t.agree) list.push(`'${t.agree.question.short}' 답이 저랑 같아서 반가웠어요 ㅎㅎ`);
  list.push('안녕하세요! 프로필 보고 대화해 보고 싶어서 먼저 연락드려요 🙂');
  return list.slice(0, 3);
}

function replyText(me, match, myText, n, mineCount) {
  const t = topics(me, match);
  const seed = match.profile.id + n;
  // 내 첫 메시지가 인사면 인사로 답함 ("안녕하세요"의 "세요"를 질문으로 착각하지 않도록 먼저 확인)
  if (mineCount <= 1 && /안녕|반가|처음/.test(myText)) {
    return pick(
      [
        `안녕하세요! 먼저 말 걸어주셔서 감사해요 😊 ${t.shared.length ? `저도 ${t.shared[0]} 진짜 좋아해요!` : `저는 ${t.interest} 좋아하는 편이에요.`}`,
        `반가워요! 저도 프로필 보고 궁금했어요 ㅎㅎ ${t.myInterest ? `${t.myInterest} 좋아하세요?` : ''}`,
      ],
      seed,
    ).trim();
  }
  if (/\?|요\?|세요|나요|까요/.test(myText)) {
    return pick(
      [
        `음 저는 주말엔 주로 ${t.interest} 하면서 보내요! 그쪽은 쉬는 날 뭐 하세요?`,
        `${t.agree ? `저는 '${t.agree.question.short}'은 ${t.agree.theirAnswer} 쪽이에요.` : '좋은 질문이네요 ㅎㅎ 저는 편하게 생각하는 편이에요.'} 그쪽은 어떠세요?`,
        `ㅎㅎ 그건 만나서 얘기해 보면 더 재밌을 것 같아요! ${t.tendency ? `저는 ${t.tendency} 성향이라는 말 자주 들어요.` : ''}`.trim(),
      ],
      seed,
    );
  }
  return pick(
    ['오 그렇군요! 저도 비슷하게 생각해요 ㅎㅎ', `맞아요 ㅎㅎ ${t.myInterest ? `${t.myInterest} 얘기도 더 듣고 싶어요!` : '얘기 더 해주세요!'}`, '대화가 잘 통하는 것 같아서 좋아요 😊'],
    seed,
  );
}

// 답장 시간이 된 채팅방에 상대 메시지를 넣고, 새로 온 메시지 목록을 돌려줌
export function resolveReplies(chats, me, matchById, now = Date.now(), openRoomId = null) {
  const arrived = [];
  for (const room of Object.values(chats.rooms)) {
    if (!room.replyAt || room.replyAt > now) continue;
    const match = matchById(room.id);
    room.replyAt = null;
    if (!match) continue;
    const mine = room.messages.filter((m) => m.from === 'me');
    const theirs = room.messages.filter((m) => m.from === 'them').length;
    const text = replyText(me, match, mine.at(-1)?.text ?? '', theirs, mine.length);
    const msg = { from: 'them', text, at: now };
    room.messages.push(msg);
    if (room.id !== openRoomId) room.unread += 1;
    arrived.push({ room, msg });
  }
  return arrived;
}

// 가입을 마치면, 서로 추천된 사람 중 한 명이 먼저 말을 건 상태로 시작
export function seedChats(chats, me, matches, now = Date.now(), skip = () => false) {
  if (chats.seeded) return chats;
  const m = [...matches].filter((x) => !chats.rooms[x.profile.id] && !skip(x.profile.id)).sort((a, b) => b.values.bToA - a.values.bToA)[0];
  if (m) {
    const t = topics(me, m);
    const room = createRoom(chats, m.profile.id, 'them', now - 5 * 60_000);
    room.messages.push({
      from: 'them',
      text: t.shared.length ? `안녕하세요! ${t.shared[0]} 좋아하신다고 해서 반가운 마음에 먼저 연락드려요 😊` : '안녕하세요! 서로 추천에 떠서 먼저 인사드려요 😊 가치관 답변이 저랑 많이 비슷하시더라고요!',
      at: now - 5 * 60_000,
    });
    room.unread = 1;
  }
  chats.seeded = true;
  return chats;
}
