import { setTimeout as delay } from "node:timers/promises";
import { providerError } from "./provider-error.mjs";
const rateReasons = new Set([
  "RATE_LIMIT_EXCEEDED",
  "rateLimitExceeded",
  "userRateLimitExceeded",
]);
export function gmailCost(url) {
  const u = new URL(url);
  if (u.hostname !== "gmail.googleapis.com") return 0;
  if (/\/attachments\//.test(u.pathname)) return 20;
  if (/\/messages\/[^/]+$/.test(u.pathname))
    return ["full", "raw", "html"].includes(u.searchParams.get("format"))
      ? 60
      : 20;
  if (u.pathname.endsWith("/messages")) return 5;
  return 1;
}
export function createProviderRequest({
  fetcher = (...args) => fetch(...args),
  wait = delay,
  now = Date.now,
  random = Math.random,
} = {}) {
  let next = 0;
  return async function request(url, options = {}) {
    const cost = gmailCost(url);
    for (let attempt = 0; attempt <= 6; attempt++) {
      // Pace Gmail below the default 6,000 units/minute/user quota, with headroom.
      if (cost) {
        const ms = Math.max(0, next - now());
        if (ms) await wait(ms);
        next = Math.max(next, now()) + (cost * 60000) / 4500;
      }
      const response = await fetcher(url, {
        ...options,
        signal: AbortSignal.timeout(45000),
      });
      if (response.ok) return response.json();
      const body = await response.json().catch(() => null);
      const reason =
        body?.error?.details?.find((d) => d?.reason)?.reason ||
        body?.error?.errors?.[0]?.reason;
      const read = !options.method || options.method === "GET";
      const retry =
        read &&
        (response.status === 429 ||
          (response.status === 403 && rateReasons.has(reason)) ||
          [500, 502, 503, 504].includes(response.status));
      if (!retry || attempt === 6)
        throw Error(providerError(response.status, body));
      const header = response.headers.get("retry-after");
      const retryAfter = header
        ? Number.isFinite(Number(header))
          ? Number(header) * 1000
          : Date.parse(header) - now()
        : 0;
      await wait(
        Math.max(
          Number.isFinite(retryAfter) ? retryAfter : 0,
          Math.min(32000, 1000 * 2 ** attempt) + Math.floor(random() * 1000),
        ),
      );
    }
  };
}
