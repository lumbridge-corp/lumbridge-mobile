import { beforeAll, describe, expect, it, vi } from "vitest";

// api.ts asks `window` at import. Only `request`'s reasoning is under test here.
vi.stubGlobal("window", { dispatchEvent() {} });
vi.stubGlobal("localStorage", { getItem: () => "tok", setItem() {} });
vi.stubGlobal("Event", class {});
let request: typeof import("./data-ui").request;
beforeAll(async () => { ({ request } = await import("./data-ui")); });

const answering = (status: number, body: unknown = {}) =>
  vi.stubGlobal("fetch", async () => new Response(JSON.stringify(body), { status }));

describe("request", () => {
  // 401 comes last here: it marks this token as refused for the rest of the file.
  for (const status of [403, 429, 408]) {
    it(`calls ${status} a moment's trouble, so nothing the owner typed is thrown away`, async () => {
      answering(status);
      expect((await request("/api/tasks")).fail).toBe("offline");
    });
  }
  for (const status of [400, 413, 422]) {
    it(`calls ${status} a request that will never work`, async () => {
      answering(status, { error: "title_too_long" });
      const r = await request("/api/tasks");
      expect(r.fail).toBe("rejected");
      expect(r.why).toBe("title_too_long");
    });
  }
  it("keeps the current row from a 409 and knows 404 and 503", async () => {
    answering(409, { id: "1" });
    const r = await request<{ id: string }>("/api/tasks/1");
    expect(r.fail).toBe("conflict");
    expect(r.current?.id).toBe("1");
    answering(404);
    expect((await request("/x")).fail).toBe("gone");
    answering(503);
    expect((await request("/x")).fail).toBe("server");
  });
  it("after a 401 stops sending anything until there's a new token", async () => {
    let calls = 0;
    vi.stubGlobal("fetch", async () => { calls++; return new Response("{}", { status: 401 }); });
    expect((await request("/api/tasks")).fail).toBe("offline");
    expect((await request("/api/tasks")).fail).toBe("offline");
    expect(calls).toBe(1);
  });
});
