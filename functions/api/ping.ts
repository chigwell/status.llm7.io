export const onRequestGet: PagesFunction = async () => {
  const upstream = await fetch("https://api.llm7.io/ping", {
    headers: {
      Accept: "application/json",
      "User-Agent": "status.llm7.io",
    },
    cf: {
      cacheTtl: 0,
      cacheEverything: false,
    },
  });

  const headers = new Headers(upstream.headers);
  headers.set("Cache-Control", "no-store");
  headers.set("Access-Control-Allow-Origin", "*");

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  });
};
