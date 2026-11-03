// 공개 이미지 주소 — 인스타그램이 게시할 때 이 주소에서 JPEG 를 가져간다.
// 키는 추측할 수 없는 무작위 문자열. 업로드는 로그인한 사람만 /api/media 로 가능.
export async function onRequestGet({ params, env }) {
  if (!env.MEDIA) return new Response('media storage not bound', { status: 503 });
  const key = String(params.key || '');
  if (!/^[A-Za-z0-9_-]{16,64}\.(jpg|png|webp|gif)$/.test(key)) return new Response('not found', { status: 404 });
  const { value, metadata } = await env.MEDIA.getWithMetadata(key, { type: 'stream' });
  if (!value) return new Response('not found', { status: 404 });
  return new Response(value, {
    headers: {
      'content-type': metadata?.ct || 'image/jpeg',
      'cache-control': 'public, max-age=31536000, immutable',
      'access-control-allow-origin': '*',
    },
  });
}
