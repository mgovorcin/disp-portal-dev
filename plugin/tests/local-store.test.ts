import { loadLocal, rememberedState, saveLocal } from "../src/local-store";
import { DEFAULT_STATE } from "../src/state";

describe("local store", () => {
  beforeEach(() => localStorage.clear());

  it("round-trips points and settings, without service URLs or panel layout", () => {
    const state = rememberedState({ ...DEFAULT_STATE, tsSource: "cube", panelOpen: false });
    expect(state).not.toHaveProperty("proxyUrl");
    expect(state).not.toHaveProperty("panelOpen");
    saveLocal({ state, picks: [{ label: "P1", geometry: { type: "Point", coordinates: [1, 2] } }], reference: null });
    const back = loadLocal();
    expect(back?.state.tsSource).toBe("cube");
    expect(back?.picks[0].label).toBe("P1");
  });

  it("survives broken storage", () => {
    localStorage.setItem("opera-disp:v1", "{not json");
    expect(loadLocal()).toBeNull();
  });
});
