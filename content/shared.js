/* Isolated-world helpers. Read the DOM only — no fetch/XHR hooks. */
const Chatseek = {
  UUID:
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,

  debounce(fn, ms) {
    let timer = 0;
    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn(...args), ms);
    };
  },

  uuidFrom(hrefOrPath) {
    const match = String(hrefOrPath || "").match(Chatseek.UUID);
    return match ? match[0].toLowerCase() : null;
  },

  textOf(el) {
    if (!el) return "";
    return (el.innerText || el.textContent || "").replace(/\n{3,}/g, "\n\n").trim();
  },

  cleanClone(el) {
    const clone = el.cloneNode(true);
    clone
      .querySelectorAll("button, svg, nav, [role='button'], textarea, input")
      .forEach((node) => node.remove());
    return Chatseek.textOf(clone);
  },

  send(payload) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(payload, (res) => {
          void chrome.runtime.lastError;
          resolve(res);
        });
      } catch {
        resolve(null);
      }
    });
  },

  observe(handler) {
    const run = Chatseek.debounce(handler, 800);
    const root = document.documentElement || document.body;
    if (!root) return;
    const mo = new MutationObserver(run);
    mo.observe(root, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    let href = location.href;
    setInterval(() => {
      if (location.href !== href) {
        href = location.href;
        run();
      }
    }, 1200);
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) run();
    });
    run();
  },

  fingerprint(parts) {
    return parts.join("|");
  },

  hash(text) {
    let h = 2166136261;
    const str = String(text || "");
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(16);
  },
};
