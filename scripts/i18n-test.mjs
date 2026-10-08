import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CATALOG,
  LOCALE_FOLDER,
  LOCALE_ORDER,
  fill,
  messagesJson,
  resolveLocale,
  text,
} from "../src/i18n.js";
import { formatAbsoluteStamp, formatActivityLabel, formatDayStamp } from "../src/activity-time.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const enKeys = Object.keys(CATALOG.en).sort();
assert(LOCALE_ORDER.length === 9, "nine locales");
for (const code of LOCALE_ORDER) {
  const keys = Object.keys(CATALOG[code]).sort();
  assert(keys.join() === enKeys.join(), `${code} keys differ`);
  for (const key of keys) {
    assert(typeof CATALOG[code][key] === "string" && CATALOG[code][key].trim(), `${code}.${key} empty`);
  }
  const file = join(root, "_locales", LOCALE_FOLDER[code], "messages.json");
  const json = JSON.parse(readFileSync(file, "utf8"));
  assert(JSON.stringify(json) === JSON.stringify(messagesJson(code)), `${code} messages.json drifted from the catalog`);
  assert(Object.keys(json).sort().join() === enKeys.join(), `${code} messages.json keys`);
}

assert(CATALOG["zh-CN"].counts.includes("条消息") && !CATALOG["zh-CN"].counts.includes("则"), "zh-CN counts");
assert(CATALOG["zh-TW"].counts.includes("則訊息") && !CATALOG["zh-TW"].counts.includes("条"), "zh-TW counts");
assert(CATALOG["zh-CN"].thread.includes("条消息") && !CATALOG["zh-CN"].thread.includes("则"), "zh-CN health");
assert(CATALOG["zh-TW"].thread.includes("則訊息"), "zh-TW health");
assert(CATALOG["zh-CN"].beforeTitle.includes("一个确切时间"), CATALOG["zh-CN"].beforeTitle);
assert(!CATALOG["zh-CN"].beforeTitle.includes("一则"), "zh-CN tooltip should not say 一则");
assert(CATALOG["zh-TW"].beforeTitle.includes("一則確切時間"), CATALOG["zh-TW"].beforeTitle);
assert(CATALOG["zh-TW"].archivedBadge === "已封存" && CATALOG["zh-CN"].archivedBadge === "已归档", "archive badge wording");

const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
assert(manifest.default_locale === "en", "default locale");
assert(manifest.name === "__MSG_extName__" && manifest.description === "__MSG_extDescription__", "manifest i18n");

const panel = readFileSync(join(root, "sidepanel/panel.js"), "utf8");
assert(!/["'`][^"'`\n]*[\u4e00-\u9fff]/.test(panel), "panel.js still has hardcoded UI copy");
assert(panel.includes("chrome.storage"), "manual language uses chrome.storage");
assert(panel.includes("resolveLocale"), "follow-browser is the resolver");

assert(resolveLocale("zh-HK") === "zh-TW", "zh-HK");
assert(resolveLocale("zh") === "zh-CN", "zh");
assert(resolveLocale("pt-PT") === "pt-BR", "Portuguese uses the pt-BR catalog");
assert(resolveLocale("fr-CA") === "fr", "fr-CA");
assert(resolveLocale("en-GB") === "en", "en-GB");

const when = Date.UTC(2026, 9, 8, 4, 7);
for (const code of LOCALE_ORDER) {
  const label = formatActivityLabel(
    { updatedAtSource: "sidebar-rank", olderThanAt: when, updatedAt: when - 1000 },
    Date.now(),
    code,
  );
  const stamp = formatAbsoluteStamp(when, code);
  assert(label.before && label.text === fill(text(code, "before"), stamp), `${code} before ${label.text}`);
  assert(/早於|早于|before |より前|이전|antes de |avant |älter als /.test(label.text), `${code} missing a before-word: ${label.text}`);
  const approx = formatActivityLabel(
    { updatedAtSource: "page-bucket", updatedAt: when },
    Date.now(),
    code,
  );
  assert(approx.approx && approx.text === fill(text(code, "approx"), formatDayStamp(when, code)), `${code} approx ${approx.text}`);
  const unknown = formatActivityLabel({ updatedAtSource: "first-seen", firstSeenAt: when, updatedAt: 1 }, Date.now(), code);
  assert(unknown.unknown && unknown.text.includes(text(code, "unknown").slice(0, 4)), `${code} unknown ${unknown.text}`);
}

const enStamp = formatAbsoluteStamp(when, "en");
const jaStamp = formatAbsoluteStamp(when, "ja");
assert(enStamp !== jaStamp, `Intl should follow the locale (${enStamp} vs ${jaStamp})`);
assert(formatDayStamp(when, "de") && formatDayStamp(when, "ja"), "day stamps exist");

console.log("i18n-test ok", { locales: LOCALE_ORDER.length, keys: enKeys.length });
