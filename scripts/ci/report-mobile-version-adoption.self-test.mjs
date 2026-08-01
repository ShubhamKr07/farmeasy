/**
 * Self-test for report-mobile-version-adoption.mjs.
 *
 * PURE SYNTHETIC FIXTURES ONLY — no real App Store / Play Console / Render
 * export data exists locally, so every input below is a hand-written string
 * that mimics the documented export *shape*, not real adoption numbers. These
 * tests validate the parsing, version-comparison, share, and 72h-window logic
 * only; they assert NOTHING about real-world adoption.
 *
 * Run:  node --test scripts/ci/report-mobile-version-adoption.self-test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  compareVersions,
  versionSegments,
  isSupported,
  parseVersionAdoptionCsv,
  analyzeApiNdjson,
  buildReport,
} from "./report-mobile-version-adoption.mjs";

// ── version comparison ──────────────────────────────────────────────────────
test("versionSegments drops qualifiers", () => {
  assert.deepEqual(versionSegments("1.2.3"), [1, 2, 3]);
  assert.deepEqual(versionSegments("1.2.3-beta"), [1, 2, 3]);
  assert.deepEqual(versionSegments("1.2.3 (4)"), [1, 2, 3, 4]);
  assert.deepEqual(versionSegments("  2.0 "), [2, 0]);
  assert.deepEqual(versionSegments(null), []);
});

test("compareVersions: basic ordering + zero-padding", () => {
  assert.equal(compareVersions("1.2.0", "1.2.0"), 0);
  assert.equal(compareVersions("1.2", "1.2.0"), 0); // zero-padded
  assert.equal(compareVersions("1.2.3", "1.2.4"), -1);
  assert.equal(compareVersions("1.3.0", "1.2.9"), 1);
  assert.equal(compareVersions("2.0.0", "1.99.99"), 1);
  assert.equal(compareVersions("1.10.0", "1.9.0"), 1); // numeric, not lexical
});

test("isSupported uses >= minimum", () => {
  assert.ok(isSupported("1.2.0", "1.2.0"));
  assert.ok(isSupported("1.2.1", "1.2.0"));
  assert.ok(!isSupported("1.1.9", "1.2.0"));
});

// ── CSV parsing (synthetic) ─────────────────────────────────────────────────
const IOS_FIXTURE = [
  "App Version Name,Active Devices",
  "1.3.0,7000",
  "1.2.0,2500",
  "1.1.0,500", // unsupported vs minimum 1.2.0
].join("\n");

const ANDROID_FIXTURE = [
  "App Version Code,App Version Name,Installations",
  "210,2.0.0,100000",
  "200,1.2.0,9500",
  "190,1.0.0,500", // unsupported; version code column must be ignored
].join("\n");

test("parseVersionAdoptionCsv detects name + count columns, ignores code column", () => {
  const ios = parseVersionAdoptionCsv(IOS_FIXTURE, "ios", "1.2.0");
  assert.equal(ios.versionColumn, "App Version Name");
  assert.equal(ios.countColumn, "Active Devices");
  assert.equal(ios.totalDevices, 10000);
  assert.equal(ios.supportedDevices, 9500); // 1.3.0 + 1.2.0
  assert.equal(ios.unsupportedDevices, 500); // 1.1.0
  assert.equal(ios.rows.length, 3);
});

test("parseVersionAdoptionCsv strips thousands separators and %", () => {
  const csv = [
    "Version,Devices",
    "1.2.0,\"7,000\"",
    "1.1.0,42%",
  ].join("\n");
  const p = parseVersionAdoptionCsv(csv, "ios", "1.2.0");
  assert.equal(p.totalDevices, 7042);
  assert.equal(p.supportedDevices, 7000);
});

test("parseVersionAdoptionCsv errors loudly on undetectable columns", () => {
  const csv = "Foo,Bar\n1.2.0,100\n";
  assert.throws(
    () => parseVersionAdoptionCsv(csv, "ios", "1.2.0"),
    /could not detect version\/count columns/,
  );
});

test("parseVersionAdoptionCsv ignores version-code column for Android", () => {
  const a = parseVersionAdoptionCsv(ANDROID_FIXTURE, "android", "1.2.0");
  assert.equal(a.versionColumn, "App Version Name");
  // 2.0.0 (100k) + 1.2.0 (9500) supported; 1.0.0 (500) unsupported
  assert.equal(a.totalDevices, 110000);
  assert.equal(a.supportedDevices, 109500);
  assert.equal(a.unsupportedDevices, 500);
});

// ── NDJSON analysis (synthetic) ─────────────────────────────────────────────
// pino shape: top-level `time` (epoch ms), version nested at `req.clientVersion`.
const NOW = Date.parse("2026-08-01T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

function ndjson(entries) {
  return entries
    .map((e) =>
      JSON.stringify({
        level: 30,
        time: e.time,
        req: { method: "GET", url: "/api/x", ...(e.v ? { clientVersion: e.v } : {}) },
        msg: "request completed",
      }),
    )
    .join("\n");
}

test("analyzeApiNdjson counts unsupported and applies the 72h window", () => {
  // maxTs = NOW. Window = [NOW-72h, NOW].
  const text = ndjson([
    { time: NOW, v: "1.3.0" }, // supported
    { time: NOW - 2 * DAY, v: "1.1.0" }, // unsupported, INSIDE window (2d < 72h)
    { time: NOW - 4 * DAY, v: "1.0.0" }, // unsupported, OUTSIDE window (4d > 72h)
    { time: NOW, /* no version */ }, // web request, not counted as unsupported
  ]);
  const r = analyzeApiNdjson(text, "1.2.0");
  assert.equal(r.total, 4);
  assert.equal(r.withVersion, 3);
  assert.equal(r.withoutVersion, 1);
  assert.equal(r.unsupportedTotal, 2); // 1.1.0 + 1.0.0
  assert.equal(r.unsupportedInWindow, 1); // only the 2-day-old 1.1.0
  assert.equal(r.malformed, 0);
  assert.equal(r.unsupportedVersions["1.1.0"], 1);
  assert.equal(r.unsupportedVersions["1.0.0"], 1);
  assert.equal(r.windowEndIso, new Date(NOW).toISOString());
});

test("analyzeApiNdjson tolerates flattened top-level clientVersion + ISO ts", () => {
  const text = JSON.stringify({
    "@timestamp": "2026-08-01T12:00:00.000Z",
    clientVersion: "1.1.0",
  });
  const r = analyzeApiNdjson(text, "1.2.0");
  assert.equal(r.total, 1);
  assert.equal(r.unsupportedTotal, 1);
  assert.equal(r.unsupportedInWindow, 1); // single point defines the window
});

test("analyzeApiNdjson skips malformed lines", () => {
  const text = "not json\n" + JSON.stringify({ time: NOW, req: { clientVersion: "1.2.0" } }) + "\n";
  const r = analyzeApiNdjson(text, "1.2.0");
  assert.equal(r.malformed, 1);
  assert.equal(r.total, 1);
  assert.equal(r.unsupportedInWindow, 0);
});

test("analyzeApiNdjson treats epoch-seconds timestamps as seconds", () => {
  const sec = Math.floor(NOW / 1000); // 10-digit -> treated as seconds
  const text = JSON.stringify({ time: sec, req: { clientVersion: "1.1.0" } });
  const r = analyzeApiNdjson(text, "1.2.0");
  assert.equal(r.windowEndIso, new Date(NOW).toISOString());
  assert.equal(r.unsupportedInWindow, 1);
});

// ── aggregate report (synthetic) ────────────────────────────────────────────
test("buildReport: weighted share weights by device count across platforms", () => {
  const ios = parseVersionAdoptionCsv(IOS_FIXTURE, "ios", "1.2.0");
  const android = parseVersionAdoptionCsv(ANDROID_FIXTURE, "android", "1.2.0");
  // weighted: (9500 + 109500) / (10000 + 110000) = 119000 / 120000
  const rep = buildReport({
    minimumVersion: "1.2.0",
    threshold: 0.99,
    ios,
    android,
    api: null,
    generatedAt: "2026-08-01T12:00:00.000Z",
  });
  // 119000/120000 = 0.99166... >= 0.99 -> share passes; api=null -> api passes.
  assert.equal(rep.pass, true);
});

test("buildReport: share gate fails when weighted share < threshold", () => {
  // 90% supported, threshold 0.99 -> fail on share
  const csv = "Version,Devices\n1.2.0,90\n1.1.0,10\n";
  const parsed = parseVersionAdoptionCsv(csv, "ios", "1.2.0");
  const rep = buildReport({
    minimumVersion: "1.2.0",
    threshold: 0.99,
    ios: parsed,
    android: null,
    api: null,
    generatedAt: "2026-08-01T12:00:00.000Z",
  });
  assert.equal(rep.pass, false);
  assert.ok(rep.reasons.some((r) => r.includes("below threshold")));
  assert.match(rep.markdown, /# Mobile Version Adoption Report/);
});

test("buildReport: 72h unsupported traffic fails the api gate", () => {
  const csv = "Version,Devices\n1.2.0,1000\n"; // 100% supported
  const parsed = parseVersionAdoptionCsv(csv, "ios", "1.2.0");
  const api = analyzeApiNdjson(
    ndjson([{ time: NOW, v: "1.1.0" }]),
    "1.2.0",
  );
  const rep = buildReport({
    minimumVersion: "1.2.0",
    threshold: 0.99,
    ios: parsed,
    android: null,
    api,
    generatedAt: "2026-08-01T12:00:00.000Z",
  });
  assert.equal(rep.pass, false);
  assert.ok(rep.reasons.some((r) => r.includes("72h")));
});

test("buildReport: passes when share ok and no unsupported traffic in window", () => {
  const csv = "Version,Devices\n1.2.0,1000\n";
  const parsed = parseVersionAdoptionCsv(csv, "ios", "1.2.0");
  const api = analyzeApiNdjson(
    ndjson([{ time: NOW, v: "1.3.0" }]), // supported request inside window
    "1.2.0",
  );
  const rep = buildReport({
    minimumVersion: "1.2.0",
    threshold: 0.99,
    ios: parsed,
    android: null,
    api,
    generatedAt: "2026-08-01T12:00:00.000Z",
  });
  assert.equal(rep.pass, true);
  assert.equal(rep.reasons.length, 0);
});
