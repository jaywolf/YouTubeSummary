import { validateCustomBaseUrl } from "../domain/settings";

type OriginPermissionDetails = { origins: string[] };

export type PermissionsAdapter = {
  contains(details: OriginPermissionDetails): Promise<boolean>;
  request(details: OriginPermissionDetails): Promise<boolean>;
};

export function customOriginPattern(baseUrl: string): string {
  const url = new URL(validateCustomBaseUrl(baseUrl));
  if (url.hostname.includes("*")) {
    throw new Error("Provider hostnames cannot contain wildcards.");
  }
  if (url.protocol === "http:" && url.hostname === "localhost") {
    return "http://localhost/*";
  }
  if (url.protocol === "http:" && url.hostname === "127.0.0.1") {
    return "http://127.0.0.1/*";
  }
  return `${url.protocol}//${url.hostname}/*`;
}

export async function ensureCustomOriginPermission(
  baseUrl: string,
  permissions: PermissionsAdapter
): Promise<boolean> {
  const details = { origins: [customOriginPattern(baseUrl)] };
  if (await permissions.contains(details)) return true;
  return permissions.request(details);
}
