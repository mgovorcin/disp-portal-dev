/** Small DOM building blocks shared by the sidebar sections (cards, switches, segments). */

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> & { className?: string } = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

const CARDS_KEY = "opera-disp:cards";

function readOpen(): Record<string, boolean> {
  try {
    return JSON.parse(localStorage.getItem(CARDS_KEY) ?? "{}") as Record<string, boolean>;
  } catch {
    return {};
  }
}

function writeOpen(id: string, open: boolean): void {
  try {
    localStorage.setItem(CARDS_KEY, JSON.stringify({ ...readOpen(), [id]: open }));
  } catch {
    /* private mode / blocked storage: cards just use their defaults */
  }
}

export interface CardOptions {
  /** Key for remembering the open/closed state in this browser. */
  id: string;
  /** Open unless the user closed it before. */
  open?: boolean;
  /** Short text shown on the right of the header (e.g. a count or state). */
  badge?: HTMLElement | string;
}

/**
 * A collapsible section: `<section class="od-section od-card"><details><summary><h3>…`.
 * The `<h3>` keeps the section title queryable (`section:has(h3:text('…'))`).
 */
export function card(title: string, options: CardOptions, ...children: (Node | string)[]): HTMLElement {
  const saved = readOpen()[options.id];
  const details = el("details", { open: saved ?? options.open ?? true });
  const summary = el("summary", { className: "od-card-head" }, el("h3", { textContent: title }));
  if (options.badge !== undefined) {
    summary.append(typeof options.badge === "string" ? el("span", { className: "od-badge", textContent: options.badge }) : options.badge);
  }
  details.append(summary, el("div", { className: "od-card-body" }, ...children));
  details.addEventListener("toggle", () => writeOpen(options.id, details.open));
  const section = el("section", { className: "od-section od-card" }, details);
  section.dataset.card = options.id;
  return section;
}

/** Checkbox drawn as a switch, inside a label row: `[label text ……… (o )]`. */
export function switchRow(input: HTMLInputElement, label: string | Node, hint?: string): HTMLLabelElement {
  input.type = "checkbox";
  input.classList.add("od-switch");
  input.setAttribute("role", "switch");
  const text = el("span", { className: "od-switch-text" }, label);
  if (hint) text.append(el("small", { className: "od-hint", textContent: hint }));
  return el("label", { className: "od-row od-switch-row" }, text, input);
}

/** Radio inputs drawn as a segmented control. */
export function segmented(name: string, options: { value: string; label: string; input: HTMLInputElement }[]): HTMLElement {
  return el(
    "div",
    { className: "od-segmented", role: "radiogroup" },
    ...options.map((o) => {
      Object.assign(o.input, { type: "radio", name, value: o.value });
      return el("label", {}, o.input, el("span", { textContent: o.label }));
    }),
  );
}

/** Label + control on one grid row (forms with several settings). */
export function field(label: string, ...controls: (Node | string)[]): HTMLElement {
  return el("label", { className: "od-field" }, el("span", { className: "od-field-label", textContent: label }), el("span", { className: "od-field-control" }, ...controls));
}

/** Label above a full-width control row (wide controls such as date pairs). */
export function stackedField(label: string, ...controls: (Node | string)[]): HTMLElement {
  return el("div", { className: "od-field od-field-stack" }, el("span", { className: "od-field-label", textContent: label }), el("span", { className: "od-field-control" }, ...controls));
}

export function button(label: string, onClick: () => void, opts: { primary?: boolean; title?: string; enabled?: boolean } = {}): HTMLButtonElement {
  const b = el("button", {
    type: "button",
    className: `od-btn${opts.primary ? " od-primary" : ""}`,
    textContent: label,
    title: opts.title ?? "",
    disabled: opts.enabled === false,
  });
  b.addEventListener("click", onClick);
  return b;
}
