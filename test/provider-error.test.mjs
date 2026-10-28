import { test } from "node:test";
import assert from "node:assert/strict";
import { providerError } from "../lib/provider-error.mjs";
test("provider errors preserve diagnostic reasons and give specific next steps", () => {
  assert.match(
    providerError(403, {
      error: {
        message: "API disabled",
        details: [{ reason: "SERVICE_DISABLED" }],
      },
    }),
    /SERVICE_DISABLED.*Enable Gmail API/,
  );
  assert.match(
    providerError(403, {
      error: {
        errors: [{ reason: "insufficientPermissions" }],
        message: "Insufficient authentication scopes",
      },
    }),
    /Reconnect Gmail/,
  );
  assert.match(
    providerError(403, { error: { errors: [{ reason: "domainPolicy" }] } }),
    /administrator/,
  );
  assert.match(providerError(429, null), /Wait before retrying/);
  assert.match(
    providerError(400, {
      error: "invalid_grant",
      error_description: "Token expired",
    }),
    /Reconnect this account/,
  );
  assert.doesNotMatch(
    providerError(403, { error: { message: "Bearer secret-token" } }),
    /secret-token/,
  );
});
