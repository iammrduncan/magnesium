import {
  type AuthEnvironmentScope,
  sessionGrantsScope,
  sessionHasLegacyPermissions,
} from "@t3tools/contracts";

/**
 * Whether a caller's grant covers `scope`. A grant from before granular
 * permissions holds only the old, broad scopes, which upstream reads as the
 * permissions they implied: `orchestration:operate` covers maintaining the
 * environment, for one. A device paired then keeps doing what it could, as it
 * does on upstream's own routes; a granular grant needs the scope itself.
 */
export const grantsScope = (
  scopes: ReadonlyArray<AuthEnvironmentScope>,
  scope: AuthEnvironmentScope,
): boolean =>
  scopes.includes(scope) ||
  (sessionHasLegacyPermissions({ authenticated: true, permissions: scopes }) &&
    sessionGrantsScope({ authenticated: true, scopes }, scope));
