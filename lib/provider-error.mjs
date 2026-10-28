export function providerError(status, body) {
  const error = body?.error;
  const reason =
    error?.details?.find((detail) => detail?.reason)?.reason ||
    error?.errors?.[0]?.reason ||
    error?.code ||
    (typeof error === "string" ? error : "");
  const detail = String(error?.message || body?.error_description || "")
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/[\r\n]+/g, " ")
    .slice(0, 500);
  let action = "";
  if (["SERVICE_DISABLED", "accessNotConfigured"].includes(reason))
    action =
      " Enable Gmail API in the Google Cloud project that owns this OAuth client.";
  else if (
    ["ACCESS_TOKEN_SCOPE_INSUFFICIENT", "insufficientPermissions"].includes(
      reason,
    )
  )
    action = " Reconnect Gmail and approve read-only mail access.";
  else if (reason === "domainPolicy")
    action = " Your organization administrator must allow this app.";
  else if (
    status === 429 ||
    [
      "RATE_LIMIT_EXCEEDED",
      "rateLimitExceeded",
      "userRateLimitExceeded",
    ].includes(reason)
  )
    action = " Wait before retrying; the provider is rate limiting requests.";
  else if (status === 401 || reason === "invalid_grant")
    action = " Reconnect this account.";
  return `Provider request failed (${status})${reason ? " [" + String(reason).slice(0, 100) + "]" : ""}${detail ? ": " + detail : "."}${action}`;
}
