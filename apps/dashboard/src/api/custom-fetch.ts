/**
 * Custom fetch wrapper for Orval-generated API client.
 */

export type ErrorType<T> = T;
export type BodyType<T> = T;

export const customFetch = async <T>(
  url: string,
  options: RequestInit & { data?: unknown } = {},
): Promise<T> => {
  const { data, headers: customHeaders, ...rest } = options;

  const response = await fetch(url, {
    ...rest,
    headers: {
      "Content-Type": "application/json",
      ...customHeaders,
    },
    ...(data ? { body: JSON.stringify(data) } : {}),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({
      error: { message: response.statusText, type: "api_error" },
    }));
    throw error;
  }

  return response.json() as Promise<T>;
};
