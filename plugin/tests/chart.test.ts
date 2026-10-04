import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { TimeseriesChart, describeFit, legendEntries, prepareSeries, toFitModel } from "../src/chart";
import { fitCsv, modelLabel, picksCsv } from "../src/chart-panel";
import type { Pick } from "../src/picks";
import { parseTimeseries } from "../src/timeseries";

const fixture = JSON.parse(readFileSync(resolve(import.meta.dirname, "data/timeseries_point_F08882.json"), "utf8"));

function pick(id: number): Pick {
  const series = parseTimeseries(fixture, "asc");
  return {
    id,
    label: `P${id}`,
    color: "#4e79a7",
    geometry: { type: "Point", coordinates: [1, 2] },
    wkt: "POINT(1 2)",
    anchor: [1, 2],
    results: { asc: { status: "ok", series }, desc: { status: "error", error: "No valid data" } },
    cube: { status: "ok", series: [] },
  };
}

const fit = { polyOrder: 1 as const, annual: false, semiannual: false, steps: ["2017-01-01"], rejectOutliers: false };

describe("chart model plumbing", () => {
  it("converts step dates and labels the model", () => {
    expect(toFitModel(fit).steps).toEqual([Date.UTC(2017, 0, 1)]);
    expect(modelLabel({ ...fit, polyOrder: 2, annual: true, rejectOutliers: true })).toBe("quadratic + annual + 1 step(s) + 3σ outliers");
  });

  it("fits each prepared series and describes it", () => {
    const [s] = prepareSeries([pick(1)], { showFit: true, reference: null, fit });
    expect(s.fit).not.toBeNull();
    expect(s.fit!.steps).toHaveLength(1);
    const text = describeFit(s.fit);
    expect(text).toMatch(/^rate [+-]\d+\.\d ± \d+\.\d mm\/yr · step 2017-01-01 [+-]\d+\.\d ± \d+\.\d mm · RMS/);
    expect(describeFit(null)).toMatch(/not estimable/);
  });

  it("exports data with model columns and a parameter table", () => {
    const data = picksCsv([pick(1)], null, fit, true).trim().split("\n");
    const header = data[0].split(",");
    expect(header).toEqual(expect.arrayContaining(["model_m", "residual_m", "outlier", "source", "variable"]));
    const row = data[1].split(",");
    const value = Number(row[header.indexOf("displacement_m")]);
    const model = Number(row[header.indexOf("model_m")]);
    expect(Number(row[header.indexOf("residual_m")])).toBeCloseTo(value - model, 5);

    const params = fitCsv([pick(1)], null, fit).trim().split("\n");
    const ph = params[0].split(",");
    expect(ph).toEqual(expect.arrayContaining(["rate_mm", "rate_std_mm", "step_2017_01_01_mm", "rms_mm", "n_outliers"]));
    expect(params).toHaveLength(2); // the desc direction has no data
    expect(params[1]).toContain("linear + 1 step(s)");
  });
});


describe("chart legend and collapsed table", () => {
  const plain = { ...fit, steps: [] };

  it("lists one legend entry per plotted series with the fitted rate", () => {
    const prepared = prepareSeries([pick(1)], { showFit: true, reference: null, fit: plain, source: "asf" });
    const entries = legendEntries(prepared, { showFit: true, reference: null, fit: plain });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ label: "P1 asc", marker: "circle", color: "#4e79a7" });
    expect(entries[0].detail).toMatch(/^[+-]\d+\.\d ± \d+\.\d mm\/yr$/);
    const modelOnly = legendEntries(prepared, { showFit: true, reference: null, fit: plain, modelOnly: true });
    expect(modelOnly[0].marker).toBe("line");
  });

  it("folds series without data into one expandable group", () => {
    const host = document.createElement("div");
    const chart = new TimeseriesChart(host);
    const picks = [1, 2, 3].map(pick);
    for (const p of picks.slice(1)) p.results.asc = { status: "error", error: "Time series failed: 400: No data found for the given area of interest POINT(1 2)" };
    // The good pick is the reference, so nothing is plotted (no canvas in the test DOM) and
    // only the table is rendered.
    chart.update(picks, { showFit: true, reference: picks[0], fit: plain, source: "asf" });
    const groups = host.querySelectorAll("details.od-ts-group");
    expect(groups).toHaveLength(2);
    expect(groups[0].querySelector("summary")?.textContent).toBe("Series and fits (1)");
    const failed = host.querySelector("details.od-ts-failed")!;
    expect((failed as HTMLDetailsElement).open).toBe(false);
    expect(failed.querySelector("summary")?.textContent).toBe("5 series without data (3 points)");
    expect(failed.textContent).toContain("No data found for the given area of interest");
    expect(failed.textContent).not.toContain("Time series failed: 400");
    chart.destroy();
  });
});

import { parseStyles } from "../src/state";
import { resolveStyle } from "../src/chart";

describe("series styles", () => {
  it("resolves defaults and overrides", () => {
    const s = { label: "P1 desc", direction: "desc" as const, source: "asf" as const, pick: { color: "#4e79a7" } };
    expect(resolveStyle(s, {})).toMatchObject({ color: "#4e79a7", marker: "ring", size: 5, fitDash: "dashed", fitColor: "#4e79a7" });
    const st = resolveStyle(s, { styles: { "P1 desc": { color: "#ff0000", marker: "triangle", size: 8, fitWidth: 3, fitDash: "dotted" } } });
    expect(st).toMatchObject({ color: "#ff0000", marker: "triangle", size: 8, fitColor: "#ff0000", fitWidth: 3, fitDash: "dotted" });
  });

  it("validates saved styles", () => {
    expect(parseStyles({ "P1 asc": { color: "#00ff00", marker: "star", size: 99, fitDash: "dotted" }, bad: 3 })).toEqual({
      "P1 asc": { color: "#00ff00", fitDash: "dotted" },
    });
    expect(parseStyles([1, 2])).toBeNull();
  });

  it("uses the styled marker in the legend", () => {
    const prepared = prepareSeries([pick(1)], { showFit: true, reference: null, fit: { ...fit, steps: [] }, source: "asf" });
    const e = legendEntries(prepared, { showFit: true, reference: null, styles: { "P1 asc": { marker: "square", color: "#123456" } } });
    expect(e[0]).toMatchObject({ marker: "square", color: "#123456" });
  });
});
