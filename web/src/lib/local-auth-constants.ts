// Plain constants/helpers with no server-only dependencies (no next/headers) so
// Edge Middleware can import this safely without pulling in Node-only code.
export const LOCAL_AUTH_COOKIE = "marathon_auth";
export const LOCAL_AUTH_TOKEN = "marathon_local_session_v1";
export const LOCAL_USERNAME = "marathon";
export const LOCAL_PASSWORD = "marathon364";
export const LOCAL_AUTH_EMAIL = "marathon@local.only1";

export function isValidCredential(username: string, password: string) {
  return username === LOCAL_USERNAME && password === LOCAL_PASSWORD;
}
