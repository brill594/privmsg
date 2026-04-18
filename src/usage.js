export const USAGE_LIMIT_VARIABLES = [
  "USAGE_LIMIT_D1_ROWS_READ_DAILY",
  "USAGE_LIMIT_D1_ROWS_WRITTEN_DAILY",
  "USAGE_LIMIT_D1_STORAGE_GB",
  "USAGE_LIMIT_R2_CLASS_A_MONTHLY",
  "USAGE_LIMIT_R2_CLASS_B_MONTHLY",
  "USAGE_LIMIT_R2_STORAGE_GB_MONTH"
];

export const USAGE_COUNTER_SCOPE_DAY = "day";
export const USAGE_COUNTER_SCOPE_MONTH = "month";

export const USAGE_COUNTER_METRICS = {
  D1_ROWS_READ: "d1_rows_read",
  D1_ROWS_WRITTEN: "d1_rows_written",
  R2_CLASS_A_OPS: "r2_class_a_ops",
  R2_CLASS_B_OPS: "r2_class_b_ops",
  R2_STORAGE_MB_SECONDS: "r2_storage_mb_seconds"
};

export const USAGE_STATE_KEYS = {
  D1_STORAGE_BYTES: "d1_storage_bytes",
  R2_STORAGE_BYTES: "r2_storage_bytes"
};

export const BILLING_MONTH_SECONDS = 30 * 24 * 60 * 60;
export const BYTES_PER_GB = 1_000_000_000;
export const BYTES_PER_MB = 1_000_000;

export function parseUsageLimits(env) {
  return {
    d1RowsReadDaily: parsePositiveInteger(env?.USAGE_LIMIT_D1_ROWS_READ_DAILY),
    d1RowsWrittenDaily: parsePositiveInteger(env?.USAGE_LIMIT_D1_ROWS_WRITTEN_DAILY),
    d1StorageBytes: parsePositiveGigabytes(env?.USAGE_LIMIT_D1_STORAGE_GB),
    r2ClassAOpsMonthly: parsePositiveInteger(env?.USAGE_LIMIT_R2_CLASS_A_MONTHLY),
    r2ClassBOpsMonthly: parsePositiveInteger(env?.USAGE_LIMIT_R2_CLASS_B_MONTHLY),
    r2StorageGbMonth: parsePositiveNumber(env?.USAGE_LIMIT_R2_STORAGE_GB_MONTH)
  };
}

export function hasAnyUsageLimit(limits) {
  return Object.values(limits || {}).some((value) => value !== null);
}

export function getUsageWindow(now = new Date()) {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const monthStartMs = Date.UTC(year, month, 1, 0, 0, 0, 0);
  const nextMonthStartMs = Date.UTC(year, month + 1, 1, 0, 0, 0, 0);

  return {
    dayKey: now.toISOString().slice(0, 10),
    monthKey: `${year}-${String(month + 1).padStart(2, "0")}`,
    monthStartMs,
    nextMonthStartMs
  };
}

export function createUsageRecorder() {
  return {
    d1RowsReadDaily: 0,
    d1RowsWrittenDaily: 0,
    d1StorageBytesObserved: null,
    r2ClassAOpsMonthly: 0,
    r2ClassBOpsMonthly: 0,
    r2StorageBytesDelta: 0,
    r2StorageMbSecondsMonthly: 0
  };
}

export function hasUsageDeltas(recorder) {
  return Boolean(
    recorder &&
      (recorder.d1RowsReadDaily ||
        recorder.d1RowsWrittenDaily ||
        recorder.d1StorageBytesObserved !== null ||
        recorder.r2ClassAOpsMonthly ||
        recorder.r2ClassBOpsMonthly ||
        recorder.r2StorageBytesDelta ||
        recorder.r2StorageMbSecondsMonthly)
  );
}

export function recordD1Meta(recorder, meta = {}) {
  if (!recorder || !meta || typeof meta !== "object") {
    return;
  }

  recorder.d1RowsReadDaily += finiteNumber(meta.rows_read);
  recorder.d1RowsWrittenDaily += finiteNumber(meta.rows_written);

  const sizeAfter = finiteNumber(meta.size_after);
  if (sizeAfter > 0 || meta.size_after === 0) {
    recorder.d1StorageBytesObserved = sizeAfter;
  }
}

export function addR2ClassA(recorder, count = 1) {
  if (!recorder) {
    return;
  }

  recorder.r2ClassAOpsMonthly += finiteNumber(count);
}

export function addR2ClassB(recorder, count = 1) {
  if (!recorder) {
    return;
  }

  recorder.r2ClassBOpsMonthly += finiteNumber(count);
}

export function addR2StorageBytes(recorder, deltaBytes) {
  if (!recorder) {
    return;
  }

  recorder.r2StorageBytesDelta += finiteNumber(deltaBytes);
}

export function addR2StorageMbSeconds(recorder, value) {
  if (!recorder) {
    return;
  }

  recorder.r2StorageMbSecondsMonthly += finiteNumber(value);
}

export function bytesToGigabytes(bytes) {
  return finiteNumber(bytes) / BYTES_PER_GB;
}

export function gigabytesToBytes(value) {
  return finiteNumber(value) * BYTES_PER_GB;
}

export function gbMonthToMbSeconds(value) {
  return finiteNumber(value) * 1000 * BILLING_MONTH_SECONDS;
}

export function mbSecondsToGbMonth(value) {
  return finiteNumber(value) / (1000 * BILLING_MONTH_SECONDS);
}

export function calculateR2StorageMbSeconds(bytes, startMs, endMs) {
  const safeStartMs = finiteNumber(startMs);
  const safeEndMs = finiteNumber(endMs);

  if (safeEndMs <= safeStartMs) {
    return 0;
  }

  return (finiteNumber(bytes) / BYTES_PER_MB) * ((safeEndMs - safeStartMs) / 1000);
}

export function evaluateUsage(snapshot, limits, projected = {}) {
  const values = {
    d1RowsReadDaily: finiteNumber(snapshot?.d1RowsReadDaily) + finiteNumber(projected.d1RowsReadDaily),
    d1RowsWrittenDaily: finiteNumber(snapshot?.d1RowsWrittenDaily) + finiteNumber(projected.d1RowsWrittenDaily),
    d1StorageBytes: finiteNumber(snapshot?.d1StorageBytes) + finiteNumber(projected.d1StorageBytes),
    r2ClassAOpsMonthly: finiteNumber(snapshot?.r2ClassAOpsMonthly) + finiteNumber(projected.r2ClassAOpsMonthly),
    r2ClassBOpsMonthly: finiteNumber(snapshot?.r2ClassBOpsMonthly) + finiteNumber(projected.r2ClassBOpsMonthly),
    r2StorageGbMonth: finiteNumber(snapshot?.r2StorageGbMonth) + finiteNumber(projected.r2StorageGbMonth),
    r2StorageBytes: finiteNumber(snapshot?.r2StorageBytes) + finiteNumber(projected.r2StorageBytes)
  };

  const breaches = [];

  pushBreach(breaches, "d1_rows_read_daily", values.d1RowsReadDaily, limits?.d1RowsReadDaily);
  pushBreach(breaches, "d1_rows_written_daily", values.d1RowsWrittenDaily, limits?.d1RowsWrittenDaily);
  pushBreach(breaches, "d1_storage_gb", bytesToGigabytes(values.d1StorageBytes), limitBytesToGigabytes(limits?.d1StorageBytes));
  pushBreach(breaches, "r2_class_a_monthly", values.r2ClassAOpsMonthly, limits?.r2ClassAOpsMonthly);
  pushBreach(breaches, "r2_class_b_monthly", values.r2ClassBOpsMonthly, limits?.r2ClassBOpsMonthly);
  pushBreach(breaches, "r2_storage_gb_month", values.r2StorageGbMonth, limits?.r2StorageGbMonth);

  return {
    values,
    breaches
  };
}

export function buildUsageSummary(snapshot, limits, now = new Date()) {
  const { dayKey, monthKey, nextMonthStartMs } = getUsageWindow(now);
  const evaluation = evaluateUsage(snapshot, limits);

  return {
    windows: {
      d1Daily: {
        period: dayKey,
        resetsAt: new Date(Date.parse(`${dayKey}T00:00:00.000Z`) + 24 * 60 * 60 * 1000).toISOString()
      },
      r2Monthly: {
        period: monthKey,
        resetsAt: new Date(nextMonthStartMs).toISOString()
      }
    },
    usage: {
      d1: {
        rowsReadDaily: finiteNumber(snapshot?.d1RowsReadDaily),
        rowsWrittenDaily: finiteNumber(snapshot?.d1RowsWrittenDaily),
        storageBytes: finiteNumber(snapshot?.d1StorageBytes),
        storageGb: roundNumber(bytesToGigabytes(snapshot?.d1StorageBytes), 6)
      },
      r2: {
        classAOpsMonthly: finiteNumber(snapshot?.r2ClassAOpsMonthly),
        classBOpsMonthly: finiteNumber(snapshot?.r2ClassBOpsMonthly),
        storageBytes: finiteNumber(snapshot?.r2StorageBytes),
        storageGb: roundNumber(bytesToGigabytes(snapshot?.r2StorageBytes), 6),
        storageGbMonth: roundNumber(finiteNumber(snapshot?.r2StorageGbMonth), 6)
      }
    },
    limits: {
      d1: {
        rowsReadDaily: limits?.d1RowsReadDaily,
        rowsWrittenDaily: limits?.d1RowsWrittenDaily,
        storageGb: limits?.d1StorageBytes === null ? null : roundNumber(bytesToGigabytes(limits?.d1StorageBytes), 6)
      },
      r2: {
        classAOpsMonthly: limits?.r2ClassAOpsMonthly,
        classBOpsMonthly: limits?.r2ClassBOpsMonthly,
        storageGbMonth: limits?.r2StorageGbMonth === null ? null : roundNumber(limits?.r2StorageGbMonth, 6)
      }
    },
    exceeded: evaluation.breaches
  };
}

function parsePositiveInteger(value) {
  if (value == null || value === "") {
    return null;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return null;
  }

  return parsed;
}

function parsePositiveNumber(value) {
  if (value == null || value === "") {
    return null;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }

  return parsed;
}

function parsePositiveGigabytes(value) {
  const parsed = parsePositiveNumber(value);
  return parsed === null ? null : gigabytesToBytes(parsed);
}

function finiteNumber(value) {
  const numericValue = Number(value);
  return Number.isFinite(numericValue) ? numericValue : 0;
}

function pushBreach(target, metric, current, limit) {
  if (limit === null || limit === undefined) {
    return;
  }

  if (current > limit) {
    target.push({
      metric,
      current: roundNumber(current, 6),
      limit: roundNumber(limit, 6)
    });
  }
}

function limitBytesToGigabytes(limitBytes) {
  if (limitBytes === null || limitBytes === undefined) {
    return null;
  }

  return bytesToGigabytes(limitBytes);
}

function roundNumber(value, digits = 2) {
  const numericValue = finiteNumber(value);
  return Number(numericValue.toFixed(digits));
}
