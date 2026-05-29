export default async function handler(req, res) {
  const baseURL = process.env.FREELLM_BASE_URL;
  const apiKey = process.env.FREELLM_API_KEY;
  if (!baseURL) {
    res.status(500).json({ error: "FREELLM_BASE_URL env var is not set" });
    return;
  }
  if (!apiKey) {
    res.status(500).json({ error: "FREELLM_API_KEY env var is not set" });
    return;
  }

  const cookie = req.headers.cookie || "";
  const match = cookie.match(/(?:^|;\s*)flsid=([^;]+)/);
  const identifier = match
    ? decodeURIComponent(match[1])
    : "anon-" + Math.random().toString(36).slice(2, 12);

  const host =
    process.env.FREELLM_ALLOWED_ORIGIN || req.headers["x-forwarded-host"] || req.headers.host || "";
  const proto = (req.headers["x-forwarded-proto"] || "https").split(",")[0];
  const origin = process.env.FREELLM_ALLOWED_ORIGIN || (host ? proto + "://" + host : "");

  try {
    const r = await fetch(baseURL.replace(/\/$/, "") + "/v1/tokens/issue", {
      method: "POST",
      headers: { Authorization: "Bearer " + apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({ origin, identifier, ttlSeconds: 900 }),
    });
    const body = await r.json();
    if (!r.ok) {
      res.status(r.status).json({ error: body?.error || "token issue failed" });
      return;
    }
    res.setHeader("Cache-Control", "no-store");
    res.status(200).json({ ...body, baseURL });
  } catch (err) {
    res.status(502).json({ error: "upstream error: " + err.message });
  }
}
