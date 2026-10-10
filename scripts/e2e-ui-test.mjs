import { ElementHandle } from "puppeteer-core";
import { JSDOM } from "jsdom";
import { clickForeground } from "./e2e-ui.mjs";

let checks = 0;
function assert(value, label) { checks++; if (!value) throw Error(label); }
const dom = new JSDOM("<button id='archived'>Archived</button>");
globalThis.Node = dom.window.Node;
globalThis.SVGElement = dom.window.SVGElement;
let visible = false;
const observers = new Set();
// Deliberately withheld delivery models a background page without a paint.
// This is not a claim about Chrome scheduling: the installed Puppeteer code
// itself is exercised to distinguish a pending IO promise from a JS deadlock.
globalThis.IntersectionObserver = class {
  constructor(callback) { this.callback = callback; }
  observe() { observers.add(this); if (visible) queueMicrotask(() => this.deliver()); }
  deliver() { this.callback([{ intersectionRatio: 1 }]); }
  disconnect() { observers.delete(this); }
};
const calls = [];
const realm = {};
const frame = { isolatedRealm: () => realm, page: () => ({ mouse: {
  async click() { calls.push("mouse"); dom.window.document.querySelector("button").click(); },
} }) };
class SampleElement extends ElementHandle {
  get realm() { return realm; }
  get frame() { return frame; }
  async clickablePoint() { return { x: 1, y: 1 }; }
}
const element = new SampleElement({ disposed: false,
  evaluate: async (fn, ...args) => fn(dom.window.document.querySelector("button"), ...args),
});
const page = {
  async bringToFront() {
    calls.push("focus"); visible = true;
    for (const observer of observers) observer.deliver();
  },
  async click(selector) { calls.push(selector); await element.click(); },
};
try {
  let settled = false;
  const pending = element.click().then(() => { settled = true; });
  await new Promise(setImmediate);
  assert(!settled && observers.size === 1, "installed Puppeteer waits for an intersection callback");
  assert(!calls.includes("mouse"), "waiting happens before mouse input or product click handlers");
  assert(await element.evaluate(() => 2 + 2) === 4, "another evaluation responds while click is pending");
  await page.bringToFront();
  await pending;
  assert(settled && calls.at(-1) === "mouse", "intersection delivery resumes the original click");
  calls.length = 0; visible = false;
  await clickForeground(page, "#archived");
  assert(calls.join(",") === "focus,#archived,mouse", "helper focuses before Puppeteer visibility check and input");
  assert(observers.size === 0, "observer disconnects after the visibility check");
  let clicked = false;
  const focusError = Error("focus failed");
  await clickForeground({ bringToFront: async () => { throw focusError; }, click: async () => { clicked = true; } }, "#archived")
    .then(() => { throw Error("expected focus error"); }, (error) => assert(error === focusError && !clicked, "focus failure propagates without clicking"));
  const clickError = Error("click failed");
  await clickForeground({ bringToFront: async () => {}, click: async () => { throw clickError; } }, "#archived")
    .then(() => { throw Error("expected click error"); }, (error) => assert(error === clickError, "click failure propagates without retrying or hiding it"));
} finally { dom.window.close(); }
console.log("e2e-ui-test ok", { checks, installedPuppeteer: true, simulatedIntersectionDelivery: true });
