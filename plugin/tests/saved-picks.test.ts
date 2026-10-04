import { PickManager, parseSavedPicks } from "../src/picks";
import { AsfClient } from "../src/services";
import { TimeseriesClient } from "../src/timeseries";

describe("saved picks", () => {
  it("validates saved picks from a project", () => {
    const ring = [[0, 0], [1, 0], [1, 1], [0, 0]];
    const saved = parseSavedPicks([
      { label: "P1", geometry: { type: "Point", coordinates: [-95.4, 29.8] } },
      { label: "Area", geometry: { type: "Polygon", coordinates: [ring] } },
      { label: "bad", geometry: { type: "Point", coordinates: ["x", 1] } },
      { label: 3, geometry: { type: "Point", coordinates: [0, 0] } },
      { label: "line", geometry: { type: "LineString", coordinates: ring } },
    ]);
    expect(saved.map((s) => s.label)).toEqual(["P1", "Area"]);
    expect(parseSavedPicks("nope")).toEqual([]);
  });

  it("round-trips picks and the reference", () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 503 })));
    const m = new PickManager(new TimeseriesClient("http://ts", 30, 0), new AsfClient("http://ts"), () => {});
    m.add({ type: "Point", coordinates: [1, 2] }, "Well A");
    m.add({ type: "Point", coordinates: [3, 4] });
    m.setReference(m.picks[0].id);
    const saved = m.toSaved();
    expect(saved).toEqual({
      picks: [
        { label: "Well A", geometry: { type: "Point", coordinates: [1, 2] } },
        { label: "P2", geometry: { type: "Point", coordinates: [3, 4] } },
      ],
      reference: "Well A",
    });
    const other = new PickManager(new TimeseriesClient("http://ts", 30, 0), new AsfClient("http://ts"), () => {});
    other.restore(saved.picks, saved.reference);
    expect(other.picks.map((p) => p.label)).toEqual(["Well A", "P2"]);
    expect(other.reference?.label).toBe("Well A");
    other.add({ type: "Point", coordinates: [5, 6] });
    expect(other.picks.map((p) => p.label)).toEqual(["Well A", "P2", "P3"]);
    vi.unstubAllGlobals();
  });
});
