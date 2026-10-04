import { VELOCITY_CLASSES, hotspotStyle, velocityStyle } from "../src/analysis";

describe("analysis styles", () => {
  it("writes a graduated step expression GeoLibre can import", () => {
    const style = JSON.parse(velocityStyle());
    const color = style.layers[0].paint["fill-color"];
    expect(color[0]).toBe("step");
    expect(color[1]).toEqual(["to-number", ["get", "vel_mmyr"], -9999]);
    expect(color[2]).toBe(VELOCITY_CLASSES[0].color);
    expect(color.slice(3)).toEqual(VELOCITY_CLASSES.slice(1).flatMap((c) => [c.min, c.color]));
    expect(style.layers.map((l: { type: string }) => l.type)).toEqual(["fill", "line", "circle"]);
    expect(JSON.parse(hotspotStyle()).layers[1].paint["line-color"]).toBe("#d62728");
  });
});
