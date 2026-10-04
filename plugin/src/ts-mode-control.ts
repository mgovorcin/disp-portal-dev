/**
 * Map button that toggles time-series mode. Off by default so a stray click never adds a pick;
 * when on, the button is highlighted and the map cursor is a crosshair.
 */
import type { Map as MapLibreMap } from "maplibre-gl";
import type { DispController } from "./controller";

const ICON = `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor"
  stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3v18h18"/>
  <path d="M7 15l4-5 3 3 5-7"/><circle cx="7" cy="15" r="1.2" fill="currentColor"/>
  <circle cx="11" cy="10" r="1.2" fill="currentColor"/><circle cx="14" cy="13" r="1.2" fill="currentColor"/>
  <circle cx="19" cy="6" r="1.2" fill="currentColor"/></svg>`;

export class TsModeControl {
  private container: HTMLDivElement | null = null;
  private button: HTMLButtonElement | null = null;
  private map: MapLibreMap | null = null;
  private unsubscribe: (() => void) | null = null;

  constructor(private readonly controller: DispController) {}

  onAdd(map: MapLibreMap): HTMLElement {
    this.map = map;
    const container = document.createElement("div");
    container.className = "maplibregl-ctrl maplibregl-ctrl-group od-ts-mode";
    const button = document.createElement("button");
    button.type = "button";
    button.innerHTML = ICON;
    button.addEventListener("click", () => this.controller.update({ tsOnClick: !this.controller.state.tsOnClick }));
    container.append(button);
    this.container = container;
    this.button = button;
    this.unsubscribe = this.controller.subscribe({ onState: (s) => this.render(s.tsOnClick) });
    return container;
  }

  private render(on: boolean): void {
    if (!this.button) return;
    this.button.classList.toggle("od-ts-mode-on", on);
    this.button.setAttribute("aria-pressed", String(on));
    const title = on
      ? "Time-series mode ON: click the map to add a point (click here to turn off)"
      : "Time-series mode OFF: click to turn on, then click the map to add points";
    this.button.title = title;
    this.button.setAttribute("aria-label", title);
    const canvas = this.map?.getCanvasContainer();
    if (canvas) canvas.classList.toggle("od-ts-cursor", on);
  }

  onRemove(): void {
    this.unsubscribe?.();
    this.map?.getCanvasContainer().classList.remove("od-ts-cursor");
    this.container?.remove();
    this.container = null;
    this.button = null;
    this.map = null;
  }
}
