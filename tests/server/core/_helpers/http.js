// Minimal Express stand-ins for calling a route handler directly.

export function fakeRes() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

/** Run `handler(req, res)` and resolve to { status, body }. */
export async function call(handler, { body, query, headers = {}, socket = {}, ip } = {}) {
  const res = fakeRes();
  await handler({ body, query, headers, socket, ip }, res);
  return { status: res.statusCode, body: res.body };
}
