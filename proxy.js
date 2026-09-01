export const config = { runtime: 'edge' };

export default async function handler(req) {
  const url = new URL(req.url);
  // 增加简单鉴权，防止被滥用
  // 客户端需在 header 里带 x-proxy-key，值和你设的 PROXY_KEY 一致
  const proxyKey = req.headers.get('x-proxy-key');
  const expectedKey = process.env.PROXY_KEY || '';

  // 去掉 /api/proxy 前缀，转发到 opencode.ai/zen
  // 客户端请求: https://你的域名/api/proxy/zen/v1/responses
  // 转发到:     https://opencode.ai/zen/v1/responses
  const zenPath = url.pathname.replace(/^\/api\/proxy/, '');
  const targetUrl = `https://opencode.ai${zenPath}${url.search}`;

  const headers = new Headers(req.headers);
  headers.set('Host', 'opencode.ai');
  headers.delete('x-forwarded-for');
  headers.delete('x-forwarded-host');
  headers.delete('x-forwarded-proto');
  headers.delete('x-real-ip');
  headers.delete('x-proxy-key'); // 不把鉴权头转发给 opencode

  const targetReq = new Request(targetUrl, {
    method: req.method,
    headers,
    body: req.method !== 'GET' && req.method !== 'HEAD' ? req.body : undefined,
  });

  const targetRes = await fetch(targetReq);
  const resHeaders = new Headers(targetRes.headers);
  resHeaders.set('Access-Control-Allow-Origin', '*');
  resHeaders.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  resHeaders.set('Access-Control-Allow-Headers', '*');

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: resHeaders });
  }

  // 可选鉴权：如果设了 PROXY_KEY 但请求没带或不对，直接拒绝
  if (expectedKey && proxyKey !== expectedKey) {
    return new Response(JSON.stringify({ error: 'Unauthorized proxy' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });
  }

  return new Response(targetRes.body, {
    status: targetRes.status,
    statusText: targetRes.statusText,
    headers: resHeaders,
  });
}
