/**
 * Kirra API 反向代理（部署在 Deno Deploy）
 *
 * 用法：把 Hermes 里的 API 地址换成你的 Deno 应用地址，例如：
 *   https://zen-proxy.<你的ID>.deno.net/v1
 * 所有请求会被原样转发到 https://kiraai.vn/api/v1/*
 *
 * 可选安全开关：在 Deno Deploy 应用的 Settings -> Environment Variables 里添加
 *   ACCESS_TOKEN = 你的口令
 * 设置后，所有请求必须带上 header  x-api-token: 你的口令 （或 ?token=你的口令）
 */

const UPSTREAM = "https://kiraai.vn"; // Kirra API 上游（不带 /api/v1）
const API_PREFIX = "/api/v1"; // 固定映射到上游的 /api/v1

// 不透传给上游的头
const HOP_HEADERS = [
  "host",
  "cf-connecting-ip",
  "cf-ipcountry",
  "cf-ray",
  "cf-visitor",
  "cf-worker",
  "cdn-loop",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-real-ip",
  "forwarded",
  "accept-encoding",
];

function corsHeaders(): Record<string, string> {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, PUT, DELETE, PATCH, OPTIONS",
    "access-control-allow-headers": "*",
    "access-control-expose-headers": "*",
    "access-control-max-age": "86400",
  };
}

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...corsHeaders() },
  });
}

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);

  // CORS 预检直接放行
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }

  // 可选口令校验
  const accessToken = Deno.env.get("ACCESS_TOKEN");
  if (accessToken) {
    const provided =
      req.headers.get("x-api-token") || url.searchParams.get("token") || "";
    if (provided !== accessToken) {
      return json(
        { error: { message: "unauthorized: missing or invalid x-api-token" } },
        401,
      );
    }
  }

  // 首页：简单状态检查
  if (url.pathname === "/" || url.pathname === "") {
    return json({
      service: "kirra-api-proxy",
      upstream: UPSTREAM + API_PREFIX,
      usage: "把 Hermes 的 API 地址设为 https://<你的deno域名>/v1 即可",
    });
  }

  // 路径映射：去掉 /v1 或 /api/v1 前缀，统一转发到上游 /api/v1/*
  let path = url.pathname;
  if (path === "/v1" || path.startsWith("/v1/")) {
    path = path.slice(3);
  } else if (path === "/api/v1" || path.startsWith("/api/v1/")) {
    path = path.slice(7);
  }

  const upstreamUrl = UPSTREAM + API_PREFIX + path + url.search;

  // 复制请求头并清理
  const headers = new Headers(req.headers);
  for (const h of HOP_HEADERS) headers.delete(h);
  headers.set("accept-encoding", "gzip, br");

  const hasBody = req.method !== "GET" && req.method !== "HEAD";

  try {
    const resp = await fetch(upstreamUrl, {
      method: req.method,
      headers,
      body: hasBody ? req.body : undefined,
      redirect: "follow",
    });

    // 复制响应头并附加 CORS
    const outHeaders = new Headers(resp.headers);
    for (const [k, v] of Object.entries(corsHeaders())) outHeaders.set(k, v);
    outHeaders.delete("content-security-policy");
    outHeaders.delete("x-frame-options");

    // 直接透传响应体（支持 SSE 流式输出）
    return new Response(resp.body, {
      status: resp.status,
      statusText: resp.statusText,
      headers: outHeaders,
    });
  } catch (err) {
    return json(
      { error: { message: "upstream request failed: " + (err as Error).message } },
      502,
    );
  }
});
