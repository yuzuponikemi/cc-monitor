/**
 * FL-1085 differential harness.
 *
 * Loads a built dataLoader.js, runs loadUsageRecords() against the real
 * ~/.claude corpus, and writes a summary so the pre-fix and post-fix builds can
 * be compared for identical output (and for cost: wall time and peak heap).
 *
 * Usage: node fl1085_differential.js <path-to-out/dataLoader.js> <out.json> [passes]
 *
 * Env:
 *   FL1085_DIR     scan this directory instead of ~/.claude. Point it at a frozen
 *                  copy of projects/ -- the live corpus is appended to while the
 *                  harness runs, which makes record counts differ between runs.
 *   FL1085_ANALYZE 0 to pass analyzeContent:false (the cheaper code path).
 *   FL1085_TOUCH   path of a .jsonl to append a line to between passes, so the
 *                  incremental path is exercised the way the file watcher drives
 *                  it in practice (one file changed, 1,299 unchanged).
 */
const path = require('path');
const fs = require('fs');

const loaderPath = path.resolve(process.argv[2]);
const outPath = path.resolve(process.argv[3]);
const passes = Number(process.argv[4] || 1);

const { ClaudeDataLoader } = require(loaderPath);

function stable(value) {
  // Deterministic JSON for comparison: sort object keys, keep array order.
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(stable);
  if (value instanceof Set) return { __set: [...value].sort() };
  if (value instanceof Map) return { __map: [...value.entries()].sort((a, b) => String(a[0]).localeCompare(String(b[0]))) };
  const out = {};
  for (const k of Object.keys(value).sort()) out[k] = stable(value[k]);
  return out;
}

(async () => {
  const perPass = [];
  let last = null;
  let peakHeap = 0;
  const sampler = setInterval(() => {
    const h = process.memoryUsage().heapUsed;
    if (h > peakHeap) peakHeap = h;
  }, 100);

  for (let p = 0; p < passes; p++) {
    const t0 = Date.now();
    const loaded = await ClaudeDataLoader.loadUsageRecords(process.env.FL1085_DIR || undefined, {
      analyzeContent: process.env.FL1085_ANALYZE !== '0',
    });
    const ms = Date.now() - t0;
    const usage = ClaudeDataLoader.calculateUsageData(loaded.records);
    // Retained footprint: peak heapUsed only reflects how lazily V8 chose to
    // collect, so it swings wildly between runs. Forcing a full GC and then
    // reading heapUsed measures what the code actually holds on to, which is
    // what a per-file cache changes. Run node with --expose-gc to get it.
    //
    // NOTE the caller (extension.ts) assigns `this.cache.records = records` and
    // keeps it until the next refresh, so the latest records array being alive
    // here is faithful; `last` below is what models that.
    let retainedMB = null;
    if (typeof global.gc === 'function') {
      global.gc();
      global.gc();
      retainedMB = +(process.memoryUsage().heapUsed / 1048576).toFixed(1);
    }
    perPass.push({
      pass: p + 1,
      ms,
      records: loaded.records.length,
      heapUsedAfterMB: +(process.memoryUsage().heapUsed / 1048576).toFixed(1),
      retainedMB,
    });
    last = { loaded, usage };
    let stats = null;
    try {
      const mod = require(loaderPath);
      if (typeof mod.fl1085CacheStats === 'function') {
        stats = mod.fl1085CacheStats();
        perPass[perPass.length - 1].cache = stats;
      }
    } catch {}
    console.error(
      `pass ${p + 1}: ${ms} ms, ${loaded.records.length} records, retained=${retainedMB} MB` +
        (stats ? `, cache hits=${stats.hits} misses=${stats.misses} files=${stats.files} ` +
                 `cachedRecords=${stats.records} analysisLines=${stats.analysisLines} ` +
                 `(${(stats.analysisLineChars / 1e6).toFixed(2)} MB of chars)` : '')
    );

    // Simulate what the watcher actually reacts to: a single appended line.
    if (process.env.FL1085_TOUCH && p < passes - 1) {
      fs.appendFileSync(process.env.FL1085_TOUCH, String.fromCharCode(10));
      console.error(`  touched ${process.env.FL1085_TOUCH}`);
    }
  }
  clearInterval(sampler);

  const summary = {
    loaderPath,
    passes: perPass,
    peakHeapUsedMB: +(peakHeap / 1048576).toFixed(1),
    records: last.loaded.records.length,
    usage: stable(last.usage),
    contentAnalysis: stable(last.loaded.contentAnalysis),
    activityAnalysis: stable(last.loaded.activityAnalysis),
  };
  fs.writeFileSync(outPath, JSON.stringify(summary, null, 1), 'utf-8');
  console.error(`wrote ${outPath}`);

  // FL1085_SNAPSHOT=<path>: dump the post-GC heap so the retained set can be
  // attributed by class instead of guessed at.
  if (process.env.FL1085_SNAPSHOT) {
    if (typeof global.gc === 'function') { global.gc(); global.gc(); }
    require('v8').writeHeapSnapshot(process.env.FL1085_SNAPSHOT);
    console.error(`heap snapshot -> ${process.env.FL1085_SNAPSHOT}`);
  }
})().catch((e) => {
  console.error('FAILED', e);
  process.exit(1);
});
