export async function api<T>(
  path: string,
  method = "GET",
  body?: unknown,
): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    headers:
      body instanceof FormData ? {} : { "Content-Type": "application/json" },
    body:
      body === undefined
        ? undefined
        : body instanceof FormData
          ? body
          : JSON.stringify(body),
  });
  if (!res.ok) {
    if (res.status === 401 && !path.startsWith("/auth/"))
      window.dispatchEvent(new Event("mstar:unauthorized"));
    let error = `请求失败 (${res.status})`;
    try {
      error = (await res.json()).error || error;
    } catch {}
    throw new Error(error);
  }
  return res.json();
}
