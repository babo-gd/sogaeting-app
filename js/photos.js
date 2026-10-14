// 프로필 사진: 최대 3장. 서버가 없어서 줄인 이미지를 이 기기(브라우저)에만 저장
export const MAX_PHOTOS = 3;
const KEY = 'sogaeting.photos.v1';
const MAX_EDGE = 900; // 긴 변 기준 크기
const QUALITY = 0.82;

export function loadPhotos() {
  try {
    const list = JSON.parse(localStorage.getItem(KEY));
    return Array.isArray(list) ? list.filter((s) => typeof s === 'string' && s.startsWith('data:image/')).slice(0, MAX_PHOTOS) : [];
  } catch {
    return [];
  }
}

// 저장 공간이 부족하면 false
export function savePhotos(list) {
  try {
    localStorage.setItem(KEY, JSON.stringify(list.slice(0, MAX_PHOTOS)));
    return true;
  } catch {
    return false;
  }
}

async function decode(file) {
  if ('createImageBitmap' in window) {
    try {
      return await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch {}
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img;
  } finally {
    URL.revokeObjectURL(url);
  }
}

// 업로드한 사진을 줄여서 JPEG data URL로 변환
export async function resizeImage(file) {
  const img = await decode(file);
  const w = img.width;
  const h = img.height;
  const scale = Math.min(1, MAX_EDGE / Math.max(w, h));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(w * scale);
  canvas.height = Math.round(h * scale);
  canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
  img.close?.();
  return canvas.toDataURL('image/jpeg', QUALITY);
}
