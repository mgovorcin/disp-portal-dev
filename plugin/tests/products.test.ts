import { describe, expect, it } from "vitest";
import type { GeoLibreAppAPI } from "../src/host-api";
import { ProductsClient, addProductCog, frameLabel, stateSummary, type ProductFrame } from "../src/products";

const frame: ProductFrame = {
  frame: 8882,
  direction: "asc",
  state: "done",
  geotiffs: [{ path: "frames/F08882/F08882_asc_velocity.tif", kind: "velocity" }],
  cubes: ["frames/F08882/F08882_asc_90m.zarr"],
};

describe("velocity products", () => {
  it("adds a product COG with the velocity stretch", async () => {
    const calls: unknown[][] = [];
    const app: GeoLibreAppAPI = { addCogLayer: async (...args) => (calls.push(args), "p1") };
    await addProductCog(app, new ProductsClient("http://p"), frame, frame.geotiffs[0]);
    const [name, url, opts] = calls[0] as [string, string, Record<string, unknown>];
    expect(name).toBe("F08882 asc velocity (own)");
    expect(url).toBe("http://p/products/files/frames/F08882/F08882_asc_velocity.tif");
    expect(opts).toMatchObject({ colormap: "coolwarm", rescaleMin: -0.03, rescaleMax: 0.03 });
  });

  it("summarises frame states", () => {
    expect(frameLabel({ frame: 38238, direction: "desc" })).toBe("F38238 desc");
    expect(stateSummary([frame, { ...frame, state: "running" }, { ...frame, frame: 1 }])).toBe("2 done · 1 running");
    expect(stateSummary([])).toBe("no frames processed yet");
  });
});
