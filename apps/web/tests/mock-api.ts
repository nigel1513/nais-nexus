/** Raw calls to the mock API as a given seed user (tests that check status codes and error details directly). */
export type MockResponse = { status: number; body: any }; // eslint-disable-line @typescript-eslint/no-explicit-any

export async function mockApi(user: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<MockResponse> {
  const res = await fetch(`http://localhost:3000/mock-api/v1${path}`, {
    method,
    headers: { "x-mock-user": user, "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

/** Bound helper: `const api = as(USER.aResearcher); await api.get("/me")`. */
export function as(user: string) {
  return {
    get: (path: string) => mockApi(user, "GET", path),
    post: (path: string, body?: unknown, headers?: Record<string, string>) => mockApi(user, "POST", path, body, headers),
    put: (path: string, body?: unknown, headers?: Record<string, string>) => mockApi(user, "PUT", path, body, headers),
    patch: (path: string, body?: unknown) => mockApi(user, "PATCH", path, body),
    delete: (path: string) => mockApi(user, "DELETE", path),
  };
}
