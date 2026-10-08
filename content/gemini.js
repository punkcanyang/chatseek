/* Gemini (gemini.google.com). Read the DOM only. No network calls and no internal RPC. */
(() => {
  const PLATFORM = "gemini";
  const state = { lastListFp: "", lastMsgFp: "" };

  // Selectors most likely to break when Gemini ships a new UI:
  // sidebar [data-test-id="conversation"] + jslog c_<id>,
  // user-query / .query-text, model-response / message-content,
  // model-thoughts / .thoughts-container, .cdk-visually-hidden, .ql-editor.
  const ROW_SELECTOR = '[data-test-id="conversation"], a[href*="/app/"], a[href*="/gem/"]';
  const MESSAGE_LAYERS = [
    {
      name: "user-query, model-response",
      selector: "user-query, .user-query, [data-test-id='user-query'], model-response, .model-response, [data-test-id='model-response']",
    },
    {
      name: "[data-message-author-role]",
      selector: "[data-message-author-role], [data-message-author]",
    },
    {
      name: "query-text, model-response-text",
      selector: ".query-text, .query-text-line, [id^='user-query-content'], message-content, .markdown, .model-response-text, [aria-label='Gemini response']",
    },
  ];
  const SR_LINE =
    /^(?:you said|gemini said|you asked|你说了|你說了|gemini 说了|gemini 說了)$/i;
  let cachedJsonTimes = null;
  let cachedJsonAt = 0;

  function cleanId(raw) {
    const id = String(raw || "").trim();
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(id)) return null;
    if (/^(app|share|gem|gems|new|edit|create|view|chat|conversation)$/i.test(id)) {
      return null;
    }
    return id;
  }

  function parseConversationPath(pathname) {
    const path = String(pathname || "").split(/[?#]/)[0].replace(/\/+$/, "") || "/";
    if (/\/share(?:\/|$)/i.test(path)) return null;
    let match = path.match(/^(?:\/u\/(\d+))?\/app\/([A-Za-z0-9_-]{8,128})$/i);
    if (match) {
      const id = cleanId(match[2]);
      if (!id) return null;
      return { account: match[1] || "", id, gemId: "" };
    }
    match = path.match(
      /^(?:\/u\/(\d+))?\/gem\/([A-Za-z0-9_-]+)\/([A-Za-z0-9_-]{8,128})$/i,
    );
    if (!match) return null;
    if (/^(edit|create|view|new)$/i.test(match[2])) return null;
    if (/^(edit|create|view|new)$/i.test(match[3])) return null;
    const id = cleanId(match[3]);
    if (!id) return null;
    return { account: match[1] || "", id, gemId: match[2] };
  }

  function accountFromLocation(loc) {
    const match = String((loc || location).pathname || "").match(/^\/u\/(\d+)(?:\/|$)/);
    return match ? match[1] : "";
  }

  function storedUrl(parsed, loc) {
    const account = parsed.account || accountFromLocation(loc);
    const prefix = account ? `/u/${account}` : "";
    if (parsed.gemId) {
      return `https://gemini.google.com${prefix}/gem/${parsed.gemId}/${parsed.id}`;
    }
    return `https://gemini.google.com${prefix}/app/${parsed.id}`;
  }

  function titleFromDoc(doc) {
    const title = Chatseek.stripTitleSuffix((doc || document).title || "", [
      "Google Gemini",
      "Gemini",
    ]);
    if (Chatseek.isGenericTitle(title)) return "";
    return title;
  }

  function jsonTimes(doc) {
    const now = Date.now();
    if (!cachedJsonTimes || now - cachedJsonAt > 15000) {
      cachedJsonTimes = Chatseek.pageTimesFromDocument();
      cachedJsonAt = now;
    }
    return cachedJsonTimes;
  }

  function parsedFromHref(href) {
    if (!href) return null;
    try {
      const url = new URL(href, "https://gemini.google.com");
      if (url.hostname !== "gemini.google.com") return null;
      return parseConversationPath(url.pathname);
    } catch {
      return null;
    }
  }

  function idFromJslog(value) {
    const text = String(value || "");
    const quoted = text.match(/["']c_([A-Za-z0-9_-]{8,128})["']/);
    const bare = text.match(/(?:^|[^A-Za-z0-9_])c_([A-Za-z0-9_-]{8,128})/);
    return cleanId((quoted || bare)?.[1]);
  }

  function parsedFromJslog(el) {
    const nodes = [el];
    try {
      el.querySelectorAll("[jslog]").forEach((node) => nodes.push(node));
    } catch {
      // ignore
    }
    for (const node of nodes) {
      const id = idFromJslog(node.getAttribute?.("jslog"));
      if (id) return { account: "", id, gemId: "" };
    }
    const dataId = cleanId(el.getAttribute?.("data-conversation-id"));
    if (dataId) return { account: "", id: dataId, gemId: "" };
    return null;
  }

  function rowIdentity(el) {
    const link = el.matches?.("a[href]")
      ? el
      : el.querySelector?.('a[href*="/app/"], a[href*="/gem/"]');
    return parsedFromHref(link?.getAttribute?.("href") || "") || parsedFromJslog(el);
  }

  function titleFromItem(el) {
    let titleEl = null;
    try {
      titleEl = el.querySelector(
        '[data-test-id="conversation-title"], .conversation-title, .conversation-title-text, .gds-label-l',
      );
    } catch {
      titleEl = null;
    }
    const fromTitle = Chatseek.textOf(titleEl);
    if (fromTitle) return fromTitle;
    const link = el.matches?.("a[href]") ? el : el.querySelector?.("a[href]");
    const aria = (link?.getAttribute?.("aria-label") || "").trim();
    if (aria && !Chatseek.isGenericTitle(aria)) return aria;
    return Chatseek.textOf(link || el);
  }

  // findTimeNear's parent walk is built for /c/ and /chat/ anchors. Hand it the
  // timestamp node inside this row so a sibling chat's clock is not copied.
  function timeAnchor(el) {
    if (!el || el.nodeType !== 1) return null;
    try {
      const time = el.querySelector("time[datetime], time");
      if (time) return time;
    } catch {
      // The row itself may still carry a data attribute.
    }
    const names = ["datetime", "data-timestamp", "data-updated-at", "data-updatedat", "data-time"];
    if (names.some((name) => el.getAttribute?.(name))) return el;
    try {
      return el.querySelector("[data-timestamp], [data-updated-at], [data-updatedat], [data-time]");
    } catch {
      return null;
    }
  }

  function openThreadTimeNode(root) {
    let nodes = [];
    try {
      nodes = [...(root || document).querySelectorAll(
        "main time[datetime], [data-test-id='conversation-header'] time[datetime]",
      )];
    } catch {
      return null;
    }
    for (const node of nodes) {
      if (node.closest?.(
        "[data-test-id='conversation'], .conversation-items-container, conversations-list",
      )) {
        continue;
      }
      return node;
    }
    return null;
  }

  function sidebarRowElements(root) {
    let nodes = [];
    try {
      nodes = [...(root || document).querySelectorAll(ROW_SELECTOR)];
    } catch {
      return [];
    }
    const rows = [];
    for (const el of nodes) {
      if (rows.some((row) => row.contains(el))) continue;
      if (el.closest?.('[data-test-id="new-chat-button"]')) continue;
      rows.push(el);
    }
    return rows;
  }

  function extractSidebar(root, loc) {
    try {
      const here = loc || location;
      const prepared = [];
      for (const el of sidebarRowElements(root)) {
        const parsed = rowIdentity(el);
        if (!parsed) continue;
        const title = titleFromItem(el);
        if (!title || Chatseek.isGenericTitle(title)) continue;
        const prev = prepared.find((row) => row.parsed.id === parsed.id);
        if (prev) {
          if (!timeAnchor(prev.el) && timeAnchor(el)) {
            prev.el = el;
            prev.parsed = parsed;
            prev.title = title;
          }
          continue;
        }
        prepared.push({ el, parsed, title });
      }
      const byId = new Map();
      const times = jsonTimes(root);
      const elements = prepared.map((row) => row.el);
      const sectionMap = Chatseek.sectionTimesFor(elements);
      for (const slot of Chatseek.sidebarSlots(elements)) {
        const row = prepared.find((item) => item.el === slot.el);
        if (!row) continue;
        const conv = {
          id: `${PLATFORM}:${row.parsed.id}`,
          platform: PLATFORM,
          platformId: row.parsed.id,
          title: row.title,
          url: storedUrl(row.parsed, here),
        };
        if (slot.sidebarIndex != null) conv.sidebarIndex = slot.sidebarIndex;
        Chatseek.attachPageTime(conv, timeAnchor(row.el), times, sectionMap);
        Chatseek.rememberConv(byId, conv);
      }
      return [...byId.values()];
    } catch {
      return [];
    }
  }

  function blockedMessage(el) {
    if (!el || el.nodeType !== 1) return true;
    const tag = (el.tagName || "").toLowerCase();
    if (tag === "model-thoughts" || tag === "textarea" || tag === "input") return true;
    const cls = typeof el.className === "string" ? el.className : "";
    if (/\b(ql-editor|thoughts-container|thoughts-content|model-thoughts)\b/i.test(cls)) {
      return true;
    }
    try {
      return !!el.closest(
        "model-thoughts, .model-thoughts, .thoughts-container, .thoughts-content, .ql-editor, rich-textarea, textarea, [data-test-id='conversation'], .conversation-items-container, conversations-list",
      );
    } catch {
      return false;
    }
  }

  function roleFor(el) {
    const explicit = (
      el.getAttribute("data-message-author-role") ||
      el.getAttribute("data-message-author") ||
      el.getAttribute("data-role") ||
      ""
    ).toLowerCase();
    if (explicit === "user" || explicit === "human") return "user";
    if (explicit === "assistant" || explicit === "model" || explicit === "gemini") {
      return "assistant";
    }
    const tag = (el.tagName || "").toLowerCase();
    if (tag === "user-query") return "user";
    if (tag === "model-response") return "assistant";
    if (tag === "message-content") {
      try {
        if (el.closest("user-query, .user-query, .query-text")) return "user";
      } catch {
        // Treat it as the model body.
      }
      return "assistant";
    }
    const blob = `${typeof el.className === "string" ? el.className : ""} ${
      el.getAttribute("data-test-id") || ""
    }`.toLowerCase();
    if (/user-query|query-text|query-content/.test(blob)) return "user";
    if (/model-response|gemini-response/.test(blob)) return "assistant";
    const aria = (el.getAttribute("aria-label") || "").toLowerCase();
    if (aria.includes("gemini response")) return "assistant";
    return null;
  }

  function stripNoise(root) {
    const selectors = [
      "button",
      "svg",
      "textarea",
      "input",
      "nav",
      "[role='button']",
      ".ql-editor",
      "model-thoughts",
      ".model-thoughts",
      ".thoughts-container",
      ".thoughts-content",
      ".cdk-visually-hidden",
      ".visually-hidden",
      "mat-icon",
      "copy-button",
      "share-button",
    ];
    for (const sel of selectors) {
      try {
        [...root.querySelectorAll(sel)].forEach((node) => node.remove());
      } catch {
        // ignore
      }
    }
    [...root.querySelectorAll("*")].forEach((node) => {
      const cls = typeof node.className === "string" ? node.className : "";
      if (/visually-hidden/i.test(cls)) node.remove();
    });
  }

  function cleanText(text) {
    return String(text || "")
      .split(/\n+/)
      .map((line) => line.trim())
      .filter((line) => line && !SR_LINE.test(line))
      .join("\n")
      .trim();
  }

  function messageBody(el, role) {
    const root = el.cloneNode(true);
    stripNoise(root);
    const prefer = role === "user"
      ? [".query-text", ".query-text-line", "[id^='user-query-content']"]
      : ["message-content", ".markdown", ".model-response-text", ".markdown-main-panel"];
    let chunks = [];
    for (const sel of prefer) {
      try {
        if (root.matches?.(sel)) chunks.push(root);
        root.querySelectorAll(sel).forEach((node) => {
          if (!chunks.includes(node)) chunks.push(node);
        });
      } catch {
        chunks = [];
      }
      if (chunks.length) break;
    }
    const raw = chunks.length
      ? chunks.map((node) => Chatseek.textOf(node)).filter(Boolean).join("\n")
      : Chatseek.textOf(root);
    const text = cleanText(raw);
    if (!text || Chatseek.isUiNoise(text) || SR_LINE.test(text)) return "";
    if (/^(show thinking|hide thinking|查看思路|顯示思路|显示思路)$/i.test(text)) {
      return "";
    }
    return text;
  }

  function extractMessages(conversationId, doc) {
    const root = doc || document;
    const selectorsTried = MESSAGE_LAYERS.map((layer) => layer.name);
    try {
      const hit = Chatseek.queryLayers(root, MESSAGE_LAYERS);
      const candidates = [];
      for (const el of hit.nodes) {
        if (blockedMessage(el)) continue;
        const role = roleFor(el);
        if (!role) continue;
        if (candidates.some((item) => item.el === el || item.el.contains(el))) continue;
        for (let i = candidates.length - 1; i >= 0; i--) {
          if (el.contains(candidates[i].el)) candidates.splice(i, 1);
        }
        candidates.push({ el, role });
      }
      candidates.sort((a, b) => {
        if (!a.el.compareDocumentPosition) return 0;
        const pos = a.el.compareDocumentPosition(b.el);
        if (pos & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
        if (pos & Node.DOCUMENT_POSITION_PRECEDING) return 1;
        return 0;
      });
      const messages = [];
      for (const item of candidates) {
        const body = messageBody(item.el, item.role);
        if (!body) continue;
        const domId = item.el.getAttribute("data-message-id") ||
          item.el.id ||
          item.el.querySelector?.("[data-message-id]")?.getAttribute("data-message-id") ||
          Chatseek.hash(item.role + ":" + body.slice(0, 180));
        messages.push({
          id: `${PLATFORM}:${conversationId}:${domId}`,
          role: item.role,
          body,
        });
      }
      return { messages, selector: hit.name, selectorsTried };
    } catch {
      return { messages: [], selector: null, selectorsTried };
    }
  }

  function buildConversation(platformId, here, sidebar, root) {
    const parsed = parseConversationPath(here.pathname || "");
    if (!platformId || !parsed) return null;
    const fromSidebar = sidebar.find((conv) => conv.platformId === platformId);
    const conversation = {
      id: `${PLATFORM}:${platformId}`,
      platform: PLATFORM,
      platformId,
      title: titleFromDoc(root) || fromSidebar?.title || platformId,
      url: storedUrl(parsed, here),
    };
    if (fromSidebar?.sidebarIndex != null) conversation.sidebarIndex = fromSidebar.sidebarIndex;
    Chatseek.applyStoredTime(conversation, fromSidebar, jsonTimes(root));
    const header = openThreadTimeNode(root);
    if (header) Chatseek.attachPageTime(conversation, header, jsonTimes(root));
    return conversation;
  }

  function view(doc, loc) {
    const root = doc || document;
    const here = loc || location;
    const sidebar = extractSidebar(root, here);
    const temporary = Chatseek.pageKind(here, false) === "temporary";
    const platformId = temporary ? null : parseConversationPath(here.pathname || "")?.id || null;
    const extracted = platformId
      ? extractMessages(platformId, root)
      : { messages: [], selector: null, selectorsTried: MESSAGE_LAYERS.map((layer) => layer.name) };
    return {
      sidebar,
      conversation: buildConversation(platformId, here, sidebar, root),
      ...extracted,
      platformId,
      pathKind: Chatseek.pageKind(here, !!platformId),
    };
  }

  function inspect(doc, loc) {
    const viewed = view(doc, loc);
    const health = Chatseek.buildHealthReport({
      platform: PLATFORM,
      pathKind: viewed.pathKind,
      sidebarCount: viewed.sidebar.length,
      messageCount: viewed.messages.length,
      selector: viewed.selector,
      selectorsTried: viewed.selectorsTried,
    });
    return { ...viewed, health };
  }

  async function capture(doc, loc) {
    const viewed = view(doc, loc);
    return Chatseek.runCapture(state, {
      platform: PLATFORM,
      sidebar: viewed.sidebar,
      conversation: viewed.conversation,
      messages: viewed.messages,
      health: {
        pathKind: viewed.pathKind,
        selector: viewed.selector,
        selectorsTried: viewed.selectorsTried,
      },
    });
  }

  Chatseek.platforms = Chatseek.platforms || {};
  Chatseek.platforms.gemini = {
    extractSidebar,
    extractMessages,
    inspect,
    capture,
  };

  if (Chatseek.autoStart !== false) Chatseek.observe(() => capture());
})();
