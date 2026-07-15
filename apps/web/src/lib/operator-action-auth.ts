import "server-only";

import { resolveOperatorIdentity } from "./auth";

export async function requireOperatorActionIdentity() {
  const identity = await resolveOperatorIdentity();
  if (identity.state !== "authed" && identity.state !== "preview") {
    throw new Error("Operator access required");
  }
  return identity;
}
