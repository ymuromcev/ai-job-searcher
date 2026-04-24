const { test } = require("node:test");
const assert = require("node:assert/strict");

const { defaultFetch } = require("./_http.js");

const originalFetch = global.fetch;

async function withFetch(fn, callback) {
  global.fetch = fn;
  try {
    await callback();
  } finally {
    global.fetch = originalFetch;
  }
}

test("defaultFetch rejects immediately when signal is already aborted", async () => {
  const ctrl = new AbortController();
  ctrl.abort(new Error("user aborted"));
  let called = 0;
  await withFetch(
    async () => {
      called += 1;
      throw new Error("should not be called");
    },
    async () => {
      await assert.rejects(
        defaultFetch("https://x.test/", { signal: ctrl.signal, retries: 0 }),
        /user aborted/
      );
    }
  );
  assert.equal(called, 0);
});

test("defaultFetch retries on 500 and returns final response", async () => {
  const statuses = [500, 500, 200];
  let n = 0;
  await withFetch(
    async () => {
      const status = statuses[n];
      n += 1;
      return {
        ok: status >= 200 && status < 300,
        status,
        body: { cancel: async () => {} },
        async arrayBuffer() {
          return new ArrayBuffer(0);
        },
        async json() {
          return { ok: true };
        },
      };
    },
    async () => {
      const res = await defaultFetch("https://x.test/", { retries: 2, backoffMs: 1 });
      assert.equal(res.status, 200);
      assert.equal(n, 3);
    }
  );
});

test("defaultFetch returns 4xx response without retry", async () => {
  let n = 0;
  await withFetch(
    async () => {
      n += 1;
      return { ok: false, status: 404, async json() { return {}; } };
    },
    async () => {
      const res = await defaultFetch("https://x.test/", { retries: 3, backoffMs: 1 });
      assert.equal(res.status, 404);
      assert.equal(n, 1);
    }
  );
});

test("defaultFetch aborts in-flight when external signal fires", async () => {
  const ctrl = new AbortController();
  await withFetch(
    (url, opts) =>
      new Promise((_resolve, reject) => {
        opts.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      }),
    async () => {
      setTimeout(() => ctrl.abort(new Error("boom")), 5);
      await assert.rejects(
        defaultFetch("https://x.test/", { signal: ctrl.signal, retries: 0 }),
        /aborted|boom/
      );
    }
  );
});
