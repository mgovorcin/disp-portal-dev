import { DEFAULT_MODEL, decimalYear, fitModel } from "../src/fit";

const DAY = 86_400_000;
const T0 = Date.UTC(2017, 0, 1);

/** Deterministic pseudo-noise (no Math.random so tests are stable). */
const noise = (i: number, amp: number) => amp * Math.sin(i * 12.9898) * Math.cos(i * 78.233);

function series(f: (t: number) => number, n = 300, stepDays = 12, amp = 0.0005) {
  return Array.from({ length: n }, (_, i) => {
    const t = T0 + i * stepDays * DAY;
    return { t, value: f(t) + noise(i, amp) };
  });
}

const yearsFromMid = (t: number, pts: { t: number }[]) => (t - (pts[0].t + pts[pts.length - 1].t) / 2) / (365.25 * DAY);

describe("fitModel", () => {
  it("recovers a linear rate", () => {
    const pts = series((t) => 0.004 + -0.012 * ((t - T0) / (365.25 * DAY)));
    const fit = fitModel(pts, DEFAULT_MODEL)!;
    expect(fit.rate).toBeCloseTo(-0.012, 4);
    expect(fit.meanRate).toBeCloseTo(-0.012, 4);
    expect(fit.rateStd).toBeGreaterThan(0);
    expect(fit.rateStd).toBeLessThan(0.0002);
    expect(fit.names).toEqual(["offset", "rate"]);
  });

  it("recovers rate, annual and semi-annual terms and a step", () => {
    const stepT = Date.UTC(2020, 5, 15);
    const truth = (t: number) => {
      const y = decimalYear(t);
      return (
        0.01 * ((t - T0) / (365.25 * DAY)) +
        0.006 * Math.cos(2 * Math.PI * (y - 200 / 365.25)) + // annual peak near DOY 201
        0.002 * Math.sin(4 * Math.PI * y) +
        (t >= stepT ? -0.015 : 0)
      );
    };
    const pts = series(truth);
    const fit = fitModel(pts, { polyOrder: 1, annual: true, semiannual: true, steps: [stepT], rejectOutliers: false })!;
    expect(fit.rate).toBeCloseTo(0.01, 3);
    expect(fit.annual!.amplitude).toBeCloseTo(0.006, 3);
    expect(Math.abs(fit.annual!.peakDoy - 201)).toBeLessThanOrEqual(3);
    expect(fit.semiannual!.amplitude).toBeCloseTo(0.002, 3);
    expect(fit.steps[0].size).toBeCloseTo(-0.015, 3);
    expect(fit.steps[0].std).toBeGreaterThan(0);
    expect(fit.rms).toBeLessThan(0.0006);
    expect(fit.predict(stepT + DAY) - fit.predict(stepT - DAY)).toBeLessThan(-0.012);
  });

  it("estimates acceleration with order 2 (rate at mid-epoch)", () => {
    const pts = series((t) => 0.003 * ((t - T0) / (365.25 * DAY)) ** 2, 300, 12, 0.0002);
    const fit = fitModel(pts, { ...DEFAULT_MODEL, polyOrder: 2 })!;
    const mid = (pts[0].t + pts[pts.length - 1].t) / 2;
    expect(fit.coefficients[2]).toBeCloseTo(0.003, 4);
    expect(fit.rate).toBeCloseTo(2 * 0.003 * ((mid - T0) / (365.25 * DAY)), 4);
    expect(yearsFromMid(mid, pts)).toBe(0);
  });

  it("rejects outliers when asked", () => {
    const pts = series((t) => 0.01 * ((t - T0) / (365.25 * DAY)));
    pts[50].value += 0.08;
    pts[120].value -= 0.06;
    const plain = fitModel(pts, DEFAULT_MODEL)!;
    const robust = fitModel(pts, { ...DEFAULT_MODEL, rejectOutliers: true })!;
    expect(robust.nOutliers).toBeGreaterThanOrEqual(2);
    expect(robust.used[50]).toBe(false);
    expect(Math.abs(robust.rate - 0.01)).toBeLessThan(Math.abs(plain.rate - 0.01) + 1e-9);
    expect(robust.rms).toBeLessThan(plain.rms);
  });

  it("drops steps without data on both sides and handles tiny inputs", () => {
    const pts = series(() => 0, 50);
    const fit = fitModel(pts, { ...DEFAULT_MODEL, steps: [Date.UTC(2010, 0, 1), Date.UTC(2030, 0, 1)] })!;
    expect(fit.steps).toHaveLength(0);
    expect(fit.droppedSteps).toHaveLength(2);
    expect(fitModel(pts.slice(0, 1), DEFAULT_MODEL)).toBeNull();
    expect(fitModel(pts.slice(0, 3), { ...DEFAULT_MODEL, polyOrder: 3, annual: true })).toBeNull();
  });

  it("decimalYear is calendar based", () => {
    expect(decimalYear(Date.UTC(2020, 0, 1))).toBe(2020);
    expect(decimalYear(Date.UTC(2021, 6, 2, 12))).toBeCloseTo(2021.5, 3);
  });
});
