import { cookies, headers } from "next/headers";

export const LOCAL_AUTH_COOKIE = "marathon_auth";
export const LOCAL_AUTH_TOKEN = "marathon_local_session_v1";
export const LOCAL_USERNAME = "marathon";
export const LOCAL_PASSWORD = "marathon364";
export const LOCAL_AUTH_EMAIL = "marathon@local.only1";

export function isValidCredential(username: string, password: string) {
  return username === LOCAL_USERNAME && password === LOCAL_PASSWORD;
}

export async function hasLocalSession() {
  const cookieStore = await cookies();
  if (cookieStore.get(LOCAL_AUTH_COOKIE)?.value === LOCAL_AUTH_TOKEN) {
    return true;
  }

  const headerStore = await headers();
  const authHeader = headerStore.get("x-marathon-auth") ?? headerStore.get("authorization") ?? "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();

  return token === LOCAL_AUTH_TOKEN;
}
