export class ApiError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

export async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const headers = new Headers(options?.headers);
  if (options?.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');

  let response: Response;
  try {
    response = await fetch(path, { credentials: 'same-origin', ...options, headers });
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw error;
    throw new ApiError(0, 'Mất kết nối. Bạn thử lại nhé.');
  }

  const data = await response.json().catch(() => undefined);
  if (!response.ok) throw new ApiError(response.status, data?.message ?? 'Có lỗi xảy ra. Bạn thử lại nhé.');
  return data as T;
}
