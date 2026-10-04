import { parseCoordinates, searchPlaces } from "../src/search";

describe("search", () => {
  it("parses lat, lon and swaps when the first number cannot be a latitude", () => {
    expect(parseCoordinates("29.76, -95.37")).toMatchObject({ lat: 29.76, lon: -95.37 });
    expect(parseCoordinates("-95.37 29.76")).toMatchObject({ lat: 29.76, lon: -95.37 });
    expect(parseCoordinates("Houston")).toBeNull();
    expect(parseCoordinates("120, 200")).toBeNull();
  });

  it("queries Nominatim for names and maps the bounding box to w,s,e,n", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify([{ display_name: "Houston, Texas", lon: "-95.36", lat: "29.75", boundingbox: ["29.5", "30.1", "-95.9", "-95.0"] }]), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const [r] = await searchPlaces("Houston");
    expect(r).toEqual({ label: "Houston, Texas", lon: -95.36, lat: 29.75, bbox: [-95.9, 29.5, -95.0, 30.1] });
    expect(String((fetchMock.mock.calls[0] as unknown as [string])[0])).toContain("nominatim.openstreetmap.org/search?q=Houston");
    vi.unstubAllGlobals();
  });
});
