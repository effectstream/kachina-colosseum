import * as browserLevelModule from "browser-level";

const browserLevel =
  (browserLevelModule as { BrowserLevel?: unknown }).BrowserLevel ??
  (browserLevelModule as { default?: unknown }).default ??
  browserLevelModule;

export const Level = browserLevel as typeof import("browser-level").BrowserLevel;

export default {
  Level,
};
