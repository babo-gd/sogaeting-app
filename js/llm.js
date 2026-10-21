// 로컬 LLM 공통 설정 (브라우저와 서버가 함께 씀)
// 매칭 로직과 프롬프트는 js/aimatch.js

// 자기소개 로컬 LLM 프로젝트와 같은 모델: LG AI연구원 EXAONE 3.5 2.4B (한국어 특화, CPU로도 동작)
export const DEFAULT_MODEL = 'exaone3.5:2.4b';

// "김도윤" → "도윤님", "나"처럼 이름이 짧으면 "회원님"
export function callName(name = '') {
  const n = String(name).trim();
  if (/^[가-힣]{3}$/.test(n)) return `${n.slice(1)}님`;
  if (n.length >= 2) return `${n}님`;
  return '회원님';
}
