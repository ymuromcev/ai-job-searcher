// Bounded worker pool with a per-key exclusivity rule (RFC 068 §11):
// at most `concurrency` items in flight overall, and at most one in flight
// per key (one open form per ATS tenant, so a board never sees parallel
// submissions from the same candidate).
//
// runPool(items, { concurrency, keyOf, worker }) → results[] in input order.
// A worker that throws yields { error } for that item; the pool continues.

async function runPool(items, { concurrency = 4, keyOf = () => null, worker }) {
  const list = Array.from(items || []);
  const results = new Array(list.length);
  const pending = list.map((item, index) => ({ item, index }));
  const activeKeys = new Set();
  const limit = Math.max(1, Math.floor(Number(concurrency) || 1));
  let inFlight = 0;

  return new Promise((resolve) => {
    const pump = () => {
      if (pending.length === 0 && inFlight === 0) {
        resolve(results);
        return;
      }
      while (inFlight < limit) {
        const idx = pending.findIndex((p) => {
          const k = keyOf(p.item);
          return k == null || !activeKeys.has(k);
        });
        if (idx === -1) break;
        const { item, index } = pending.splice(idx, 1)[0];
        const key = keyOf(item);
        if (key != null) activeKeys.add(key);
        inFlight += 1;
        Promise.resolve()
          .then(() => worker(item, index))
          .then(
            (r) => {
              results[index] = r;
            },
            (err) => {
              results[index] = { error: err && err.message ? err.message : String(err) };
            }
          )
          .finally(() => {
            if (key != null) activeKeys.delete(key);
            inFlight -= 1;
            pump();
          });
      }
    };
    pump();
  });
}

// Serializes async critical sections (TSV read-modify-write).
function makeMutex() {
  let tail = Promise.resolve();
  return function withLock(fn) {
    const run = tail.then(fn, fn);
    tail = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  };
}

module.exports = { runPool, makeMutex };
