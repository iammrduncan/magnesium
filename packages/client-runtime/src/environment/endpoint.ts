export * from "@t3tools/shared/advertisedEndpoint";

// magnesium: keeps the base URL's path, so a machine the hub serves at
// <hub>/api/magnesium/env/<name>/ resolves under it; a bare origin behaves as before.
export const environmentEndpointUrl = (httpBaseUrl: string, pathname: string): string => {
  const url = new URL(httpBaseUrl);
  url.pathname = `${url.pathname.replace(/\/+$/, "")}${pathname}`;
  url.search = "";
  url.hash = "";
  return url.toString();
};
