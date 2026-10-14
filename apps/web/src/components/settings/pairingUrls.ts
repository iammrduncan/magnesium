import { setPairingTokenOnUrl } from "../../pairingUrl";

// magnesium: pairing links always use the server's own origin; no hosted-app (app.t3.codes) links (D13)
export function resolveDesktopPairingUrl(endpointUrl: string, credential: string): string {
  const url = new URL(endpointUrl);
  url.pathname = "/pair";
  return setPairingTokenOnUrl(url, credential).toString();
}
