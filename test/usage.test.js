import test from "node:test";
import assert from "node:assert/strict";

import {
  BILLING_MONTH_SECONDS,
  buildUsageSummary,
  calculateR2StorageMbSeconds,
  evaluateUsage,
  getUsageWindow,
  parseUsageLimits
} from "../src/usage.js";

test("parses usage limits from environment variables", () => {
  const limits = parseUsageLimits({
    USAGE_LIMIT_D1_ROWS_READ_DAILY: "5000000",
    USAGE_LIMIT_D1_ROWS_WRITTEN_DAILY: "100000",
    USAGE_LIMIT_D1_STORAGE_GB: "5",
    USAGE_LIMIT_R2_CLASS_A_MONTHLY: "1000000",
    USAGE_LIMIT_R2_CLASS_B_MONTHLY: "10000000",
    USAGE_LIMIT_R2_STORAGE_GB_MONTH: "10"
  });

  assert.equal(limits.d1RowsReadDaily, 5000000);
  assert.equal(limits.d1RowsWrittenDaily, 100000);
  assert.equal(limits.d1StorageBytes, 5_000_000_000);
  assert.equal(limits.r2ClassAOpsMonthly, 1000000);
  assert.equal(limits.r2ClassBOpsMonthly, 10000000);
  assert.equal(limits.r2StorageGbMonth, 10);
});

test("computes R2 storage reservations in MB-seconds", () => {
  const oneHourReservation = calculateR2StorageMbSeconds(1_500_000, 0, 60 * 60 * 1000);
  assert.equal(oneHourReservation, 5400);
});

test("detects projected breaches against configured limits", () => {
  const evaluation = evaluateUsage(
    {
      d1RowsReadDaily: 99,
      d1RowsWrittenDaily: 0,
      d1StorageBytes: 4_000_000_000,
      r2ClassAOpsMonthly: 0,
      r2ClassBOpsMonthly: 0,
      r2StorageBytes: 2_000_000_000,
      r2StorageGbMonth: 9.5
    },
    parseUsageLimits({
      USAGE_LIMIT_D1_ROWS_READ_DAILY: "100",
      USAGE_LIMIT_D1_STORAGE_GB: "5",
      USAGE_LIMIT_R2_STORAGE_GB_MONTH: "10"
    }),
    {
      d1RowsReadDaily: 2,
      r2StorageGbMonth: 0.75
    }
  );

  assert.deepEqual(
    evaluation.breaches.map((entry) => entry.metric),
    ["d1_rows_read_daily", "r2_storage_gb_month"]
  );
});

test("builds a usage summary payload for the API", () => {
  const now = new Date("2026-04-18T10:00:00.000Z");
  const summary = buildUsageSummary(
    {
      d1RowsReadDaily: 12,
      d1RowsWrittenDaily: 3,
      d1StorageBytes: 123_000_000,
      r2ClassAOpsMonthly: 4,
      r2ClassBOpsMonthly: 5,
      r2StorageBytes: 456_000_000,
      r2StorageGbMonth: 0.25
    },
    parseUsageLimits({
      USAGE_LIMIT_D1_ROWS_READ_DAILY: "5000000",
      USAGE_LIMIT_R2_STORAGE_GB_MONTH: "10"
    }),
    now
  );

  assert.equal(summary.windows.d1Daily.period, "2026-04-18");
  assert.equal(summary.windows.r2Monthly.period, getUsageWindow(now).monthKey);
  assert.equal(summary.usage.d1.storageGb, 0.123);
  assert.equal(summary.usage.r2.storageGbMonth, 0.25);
  assert.equal(summary.limits.r2.storageGbMonth, 10);
  assert.equal(BILLING_MONTH_SECONDS, 2_592_000);
});
