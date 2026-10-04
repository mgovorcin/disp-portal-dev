/**
 * Least-squares time-series model for displacement:
 *
 *   d(t) = sum_k c_k x^k                      polynomial, order 0..3, x = years from the mid-epoch
 *        + a1 sin(2πy) + b1 cos(2πy)          annual (y = decimal year, so phase is calendar time)
 *        + a2 sin(4πy) + b2 cos(4πy)          semi-annual
 *        + sum_j s_j H(t - T_j)               steps (offsets) at user dates T_j
 *
 * Solved with column-scaled normal equations (p <= ~12, so this is well conditioned),
 * optional iterative 3-sigma (MAD) outlier rejection, and formal 1-sigma errors from
 * sigma^2 (AᵀA)⁻¹. Times are epoch ms (UTC), values metres.
 */

export interface FitModel {
  /** Polynomial order: 0 offset, 1 linear, 2 quadratic, 3 cubic. */
  polyOrder: 0 | 1 | 2 | 3;
  annual: boolean;
  semiannual: boolean;
  /** Step dates, epoch ms. */
  steps: number[];
  /** Iteratively drop points with |residual| > 3 x robust sigma (max 5 passes). */
  rejectOutliers: boolean;
}

export const DEFAULT_MODEL: FitModel = { polyOrder: 1, annual: false, semiannual: false, steps: [], rejectOutliers: false };

export interface FitResult {
  model: FitModel;
  names: string[];
  coefficients: number[];
  stdErrors: number[];
  /** Evaluate the fitted model at time t (epoch ms). */
  predict: (t: number) => number;
  /** Polynomial-part derivative at the mid-epoch, m/yr (the velocity for order 1). */
  rate: number;
  rateStd: number;
  /** Mean rate of the polynomial part over the data span, m/yr. */
  meanRate: number;
  annual?: Harmonic;
  semiannual?: Harmonic;
  steps: { t: number; size: number; std: number }[];
  /** Steps that could not be estimated (no data on one side). */
  droppedSteps: number[];
  rms: number;
  nUsed: number;
  nOutliers: number;
  /** Per input point: true if used in the final fit. */
  used: boolean[];
  tMid: number;
}

export interface Harmonic {
  amplitude: number;
  amplitudeStd: number;
  /** Day of year of the (first) maximum. */
  peakDoy: number;
}

const YEAR_MS = 365.25 * 86_400_000;
const TWO_PI = 2 * Math.PI;

/** Decimal year of an epoch-ms time (UTC). */
export function decimalYear(t: number): number {
  const d = new Date(t);
  const y = d.getUTCFullYear();
  const start = Date.UTC(y, 0, 1);
  const end = Date.UTC(y + 1, 0, 1);
  return y + (t - start) / (end - start);
}

function columns(model: FitModel, steps: number[], tMid: number): { names: string[]; row: (t: number) => number[] } {
  const names: string[] = [];
  for (let k = 0; k <= model.polyOrder; k++) names.push(["offset", "rate", "acceleration/2", "jerk/6"][k]);
  if (model.annual) names.push("annual sin", "annual cos");
  if (model.semiannual) names.push("semiannual sin", "semiannual cos");
  for (const s of steps) names.push(`step ${new Date(s).toISOString().slice(0, 10)}`);
  const row = (t: number) => {
    const x = (t - tMid) / YEAR_MS;
    const r: number[] = [];
    for (let k = 0; k <= model.polyOrder; k++) r.push(x ** k);
    if (model.annual || model.semiannual) {
      const y = decimalYear(t);
      if (model.annual) r.push(Math.sin(TWO_PI * y), Math.cos(TWO_PI * y));
      if (model.semiannual) r.push(Math.sin(2 * TWO_PI * y), Math.cos(2 * TWO_PI * y));
    }
    for (const s of steps) r.push(t >= s ? 1 : 0);
    return r;
  };
  return { names, row };
}

/** Solve min |A c - y| via column-scaled normal equations; returns c and (AᵀA)⁻¹. */
function solve(A: number[][], y: number[]): { c: number[]; inv: number[][] } | null {
  const n = A.length;
  const p = A[0]?.length ?? 0;
  if (n < p || p === 0) return null;
  const scale = new Array(p).fill(0);
  for (const r of A) for (let j = 0; j < p; j++) scale[j] += r[j] * r[j];
  for (let j = 0; j < p; j++) {
    if (scale[j] === 0) return null;
    scale[j] = 1 / Math.sqrt(scale[j]);
  }
  const N = Array.from({ length: p }, () => new Array(p).fill(0));
  const b = new Array(p).fill(0);
  for (let i = 0; i < n; i++) {
    const r = A[i];
    for (let j = 0; j < p; j++) {
      const aj = r[j] * scale[j];
      b[j] += aj * y[i];
      for (let k = j; k < p; k++) N[j][k] += aj * r[k] * scale[k];
    }
  }
  for (let j = 0; j < p; j++) for (let k = 0; k < j; k++) N[j][k] = N[k][j];
  // Cholesky N = L Lᵀ
  const L = Array.from({ length: p }, () => new Array(p).fill(0));
  for (let j = 0; j < p; j++) {
    let d = N[j][j];
    for (let k = 0; k < j; k++) d -= L[j][k] ** 2;
    if (d <= 1e-12) return null; // collinear columns
    L[j][j] = Math.sqrt(d);
    for (let i = j + 1; i < p; i++) {
      let v = N[i][j];
      for (let k = 0; k < j; k++) v -= L[i][k] * L[j][k];
      L[i][j] = v / L[j][j];
    }
  }
  // Inverse of N via L⁻¹
  const Li = Array.from({ length: p }, () => new Array(p).fill(0));
  for (let i = 0; i < p; i++) {
    Li[i][i] = 1 / L[i][i];
    for (let j = 0; j < i; j++) {
      let v = 0;
      for (let k = j; k < i; k++) v -= L[i][k] * Li[k][j];
      Li[i][j] = v / L[i][i];
    }
  }
  const Ninv = Array.from({ length: p }, (_, i) =>
    Array.from({ length: p }, (_, j) => {
      let v = 0;
      for (let k = Math.max(i, j); k < p; k++) v += Li[k][i] * Li[k][j];
      return v;
    }),
  );
  const cs = Ninv.map((row) => row.reduce((acc, v, k) => acc + v * b[k], 0));
  return {
    c: cs.map((v, j) => v * scale[j]),
    inv: Ninv.map((row, i) => row.map((v, j) => v * scale[i] * scale[j])),
  };
}

function harmonic(s: number, c: number, varS: number, varC: number, cov: number, period: number): Harmonic {
  const amplitude = Math.hypot(s, c);
  const amplitudeStd = amplitude > 0 ? Math.sqrt(Math.max(0, (s * s * varS + c * c * varC + 2 * s * c * cov) / (amplitude * amplitude))) : 0;
  // s sin(ωy) + c cos(ωy) = A cos(ωy - φ), φ = atan2(s, c); maximum at y = φ / ω (mod period).
  let frac = Math.atan2(s, c) / TWO_PI; // in cycles
  frac = ((frac % 1) + 1) % 1;
  return { amplitude, amplitudeStd, peakDoy: Math.round(frac * period * 365.25) + 1 };
}

const median = (v: number[]) => {
  const s = [...v].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

export function fitModel(points: { t: number; value: number }[], model: FitModel): FitResult | null {
  if (points.length < 2) return null;
  const t0 = points[0].t;
  const t1 = points[points.length - 1].t;
  const tMid = (t0 + t1) / 2;
  const sorted = [...new Set(model.steps)].sort((a, b) => a - b);
  // A step needs data on both sides, otherwise it is collinear with the offset.
  const steps = sorted.filter((s) => points.some((p) => p.t < s) && points.some((p) => p.t >= s));
  const droppedSteps = sorted.filter((s) => !steps.includes(s));
  const { names, row } = columns(model, steps, tMid);
  const allRows = points.map((p) => row(p.t));
  let used = points.map(() => true);
  let result: { c: number[]; inv: number[][] } | null = null;
  let rms = 0;
  for (let pass = 0; pass < (model.rejectOutliers ? 6 : 1); pass++) {
    const idx = used.flatMap((u, i) => (u ? [i] : []));
    result = solve(idx.map((i) => allRows[i]), idx.map((i) => points[i].value));
    if (!result) return null;
    const c = result.c;
    const resid = points.map((p, i) => p.value - allRows[i].reduce((acc, v, j) => acc + v * c[j], 0));
    const usedResid = idx.map((i) => resid[i]);
    rms = Math.sqrt(usedResid.reduce((a, r) => a + r * r, 0) / usedResid.length);
    if (!model.rejectOutliers) break;
    const med = median(usedResid);
    const sigma = 1.4826 * median(usedResid.map((r) => Math.abs(r - med)));
    if (!(sigma > 0)) break;
    const next = resid.map((r) => Math.abs(r - med) <= 3 * sigma);
    if (next.every((v, i) => v === used[i])) break;
    if (next.filter(Boolean).length < names.length + 2) break;
    used = next;
  }
  if (!result) return null;
  const nUsed = used.filter(Boolean).length;
  const dof = Math.max(1, nUsed - names.length);
  const usedIdx = used.flatMap((u, i) => (u ? [i] : []));
  const rss = usedIdx.reduce((a, i) => {
    const r = points[i].value - allRows[i].reduce((acc, v, j) => acc + v * result!.c[j], 0);
    return a + r * r;
  }, 0);
  const sigma2 = rss / dof;
  const c = result.c;
  const se = result.inv.map((r, j) => Math.sqrt(Math.max(0, sigma2 * r[j])));
  const cov = (i: number, j: number) => sigma2 * result!.inv[i][j];

  let col = model.polyOrder + 1;
  let annual: Harmonic | undefined;
  let semiannual: Harmonic | undefined;
  if (model.annual) {
    annual = harmonic(c[col], c[col + 1], cov(col, col), cov(col + 1, col + 1), cov(col, col + 1), 1);
    col += 2;
  }
  if (model.semiannual) {
    semiannual = harmonic(c[col], c[col + 1], cov(col, col), cov(col + 1, col + 1), cov(col, col + 1), 0.5);
    col += 2;
  }
  const stepResults = steps.map((t, j) => ({ t, size: c[col + j], std: se[col + j] }));

  const poly = (t: number) => {
    const x = (t - tMid) / YEAR_MS;
    let v = 0;
    for (let k = 0; k <= model.polyOrder; k++) v += c[k] * x ** k;
    return v;
  };
  const spanYears = (t1 - t0) / YEAR_MS;
  return {
    model,
    names,
    coefficients: c,
    stdErrors: se,
    predict: (t: number) => row(t).reduce((acc, v, j) => acc + v * c[j], 0),
    rate: model.polyOrder >= 1 ? c[1] : 0,
    rateStd: model.polyOrder >= 1 ? se[1] : 0,
    meanRate: spanYears > 0 ? (poly(t1) - poly(t0)) / spanYears : 0,
    annual,
    semiannual,
    steps: stepResults,
    droppedSteps,
    rms,
    nUsed,
    nOutliers: points.length - nUsed,
    used,
    tMid,
  };
}
