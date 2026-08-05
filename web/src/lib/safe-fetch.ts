interface ErrorPayload {
  error?: unknown;
}

export interface SafeFetchJsonResult<T> {
  ok: boolean;
  status: number;
  data: T | null;
  error: string | null;
  rawText: string;
}

function extractErrorMessage(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;

  const maybeError = (payload as ErrorPayload).error;
  if (typeof maybeError === "string" && maybeError.trim()) return maybeError;

  if (maybeError && typeof maybeError === "object") {
    const obj = maybeError as { formErrors?: unknown; message?: unknown };
    const formErrors = obj.formErrors;
    if (Array.isArray(formErrors) && typeof formErrors[0] === "string") {
      return formErrors[0];
    }
    if (typeof obj.message === "string" && obj.message.trim()) {
      return obj.message;
    }
  }

  return null;
}

export async function safeFetchJson<T>(input: RequestInfo | URL, init?: RequestInit): Promise<SafeFetchJsonResult<T>> {
  try {
    const response = await fetch(input, init);
    const rawText = await response.text();

    let parsed: T | null = null;
    if (rawText.trim()) {
      try {
        parsed = JSON.parse(rawText) as T;
      } catch {
        // Keep parsed null and surface a readable error message below.
      }
    }

    if (!response.ok) {
      const fromPayload = extractErrorMessage(parsed);
      const fallback =
        parsed === null
          ? `Request failed (${response.status}) with non-JSON response.`
          : `Request failed (${response.status}).`;

      return {
        ok: false,
        status: response.status,
        data: parsed,
        error: fromPayload ?? fallback,
        rawText,
      };
    }

    if (parsed === null && rawText.trim()) {
      return {
        ok: false,
        status: response.status,
        data: null,
        error: "Response was not valid JSON.",
        rawText,
      };
    }

    return {
      ok: true,
      status: response.status,
      data: parsed,
      error: null,
      rawText,
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      data: null,
      error: error instanceof Error ? error.message : "Network request failed",
      rawText: "",
    };
  }
}
