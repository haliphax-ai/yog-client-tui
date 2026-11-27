import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { BaseComponent, type RenderResult } from "../../../src/ui/components/index.ts";
import { DrawerComponent } from "../../../src/ui/components/index.ts";
import {
  registerDrawerChild,
  registeredDrawerChildren,
  resetDrawerRegistryForTests,
} from "../../../src/ui/components/index.ts";
import { displayWidth, stripAnsi } from "../../../src/util/index.ts";

/** Minimal child with fixed rows (string or array form). */
class Stub extends BaseComponent {
  private readonly rows: RenderResult;
  constructor(rows: RenderResult) {
    super(false);
    this.rows = rows;
  }
  override render(): RenderResult {
    return this.rows;
  }
}

describe("DrawerComponent + registry", () => {
  beforeEach(() => {
    resetDrawerRegistryForTests();
  });
  afterEach(() => {
    resetDrawerRegistryForTests();
  });

  it("is fully collapsed when no children are registered", () => {
    const drawer = new DrawerComponent();
    expect(drawer.render({ cols: 80 })).toEqual([]);
    expect(drawer.measure(80)).toBe(0);
  });

  it("is fully collapsed when every registered child renders nothing", () => {
    registerDrawerChild(new Stub([]));
    registerDrawerChild(new Stub(""));
    const drawer = new DrawerComponent();
    expect(drawer.render({ cols: 80 })).toEqual([]);
    expect(drawer.measure(80)).toBe(0);
  });

  it("insets a visible child horizontally (no vertical pad — the log's separator blank is the gap)", () => {
    registerDrawerChild(new Stub(["hello"]));
    const drawer = new DrawerComponent();
    const rows = drawer.render({ cols: 20 });
    expect(rows).toHaveLength(2);
    expect(stripAnsi(rows[0] as string)).toBe(" hello" + " ".repeat(14));
    expect(stripAnsi(rows[1] as string)).toBe(" ".repeat(20)); // the input-side gap
    for (const row of rows) expect(displayWidth(row)).toBe(20);
    expect(drawer.measure(20)).toBe(2);
  });

  it("stacks children in registration order and normalizes string renders", () => {
    registerDrawerChild(new Stub(["aaa", "bbb"]));
    registerDrawerChild(new Stub("ccc"));
    const drawer = new DrawerComponent();
    const plain = drawer.render({ cols: 10 }).map((r) => stripAnsi(r));
    expect(plain).toEqual([
      " aaa      ",
      " bbb      ",
      "          ", // the item separator: one blank row between children
      " ccc      ",
      "          ", // the input-side gap
    ]);
  });

  it("inserts no separator before the first or after the last child", () => {
    registerDrawerChild(new Stub([]));
    registerDrawerChild(new Stub(["only"]));
    registerDrawerChild(new Stub([]));
    const drawer = new DrawerComponent();
    const plain = drawer.render({ cols: 10 }).map((r) => stripAnsi(r));
    expect(plain).toEqual([" only     ", " ".repeat(10)]);
  });

  it("skips collapsed children between visible ones", () => {
    registerDrawerChild(new Stub(["first"]));
    registerDrawerChild(new Stub([]));
    registerDrawerChild(new Stub(["second"]));
    const drawer = new DrawerComponent();
    const plain = drawer.render({ cols: 10 }).map((r) => stripAnsi(r));
    expect(plain).toEqual([" first    ", " second   ", " ".repeat(10)]);
  });

  it("truncates overlong child rows to the padded interior (no wrap explosion)", () => {
    registerDrawerChild(new Stub(["abcdefghij"]));
    const drawer = new DrawerComponent();
    const rows = drawer.render({ cols: 6 });
    expect(rows).toHaveLength(2);
    expect(stripAnsi(rows[0] as string)).toBe(" abcd ");
  });

  it("measures padding in cells, not characters (emoji regression)", () => {
    registerDrawerChild(new Stub(["✅ done"]));
    const drawer = new DrawerComponent();
    const rows = drawer.render({ cols: 10 });
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(displayWidth(row)).toBe(10);
    // "✅" is 1 char but 2 cells: " ✅ done  " is 10 cells, 9 chars.
    expect(stripAnsi(rows[0] as string)).toBe(" ✅ done  ");
    expect(drawer.measure(10)).toBe(2);
  });

  it("unregistering a child removes it from the draw", () => {
    const remove = registerDrawerChild(new Stub(["gone"]));
    registerDrawerChild(new Stub(["kept"]));
    expect(registeredDrawerChildren()).toHaveLength(2);
    remove();
    expect(registeredDrawerChildren()).toHaveLength(1);
    const drawer = new DrawerComponent();
    const plain = drawer.render({ cols: 10 }).map((r) => stripAnsi(r));
    expect(plain).toEqual([" kept     ", " ".repeat(10)]);
    remove(); // unregister is idempotent
    expect(registeredDrawerChildren()).toHaveLength(1);
  });

  it("is non-focusable and takes no keys (a pure container)", () => {
    registerDrawerChild(new Stub(["x"]));
    const drawer = new DrawerComponent();
    expect(drawer.focusable).toBe(false);
    expect(drawer.handleKey("\x1b[A")).toBe("unhandled");
    expect(drawer.handleChar("x")).toBe("unhandled");
  });
});
