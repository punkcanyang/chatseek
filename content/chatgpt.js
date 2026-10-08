(() => {
  const PLATFORM = "chatgpt";
  const state = { lastListFp: "", lastMsgFp: "" };
  let cachedJsonTimes = null;
  let cachedJsonAt = 0;

  // First hit wins. Later layers cover the late-2026 turn markup
  // (data-turn / conversation-turn / data-message-id) when the classic
  // data-message-author-role nodes are gone. A new adapter can pass its
  // own list to Chatseek.queryLayers instead of copying this walker.
  const MESSAGE_LAYERS = [
    { name: "[data-message-author-role]", selector: "[data-message-author-role]" },
    { name: "[data-turn]", selector: "[data-turn]" },
    {
      name: "[data-testid*=conversation-turn]",
      selector: "article[data-testid*='conversation-turn'], section[data-testid*='conversation-turn'], [data-testid*='conversation-turn']",
    },
    { name: "[data-message-id]", selector: "[data-message-id]" },
    { name: "main article", selector: "main article" },
  ];

  function canonicalUrl(id) {
    return `https://chatgpt.com/c/${id}`;
  }

  function conversationIdFromLocation(loc) {
    const path = (loc || location).pathname || "";
    if (!/\/c\//.test(path)) return null;
    return Chatseek.uuidFrom(path);
  }

  function titleFromDoc(doc) {
    return Chatseek.stripTitleSuffix((doc || document).title, ["ChatGPT", "OpenAI"]);
  }

  function jsonTimes(doc) {
    const now = Date.now();
    if (!cachedJsonTimes || now - cachedJsonAt > 15000) {
      cachedJsonTimes = Chatseek.pageTimesFromDocument(doc);
      cachedJsonAt = now;
    }
    return cachedJsonTimes;
  }

  function rowFromAnchor(a, times, sectionMap, slot) {
    const id = Chatseek.uuidFrom(a.getAttribute("href") || a.href);
    if (!id) return null;
    const title = Chatseek.textOf(a);
    if (!title) return null;
    const conv = {
      id: `${PLATFORM}:${id}`,
      platform: PLATFORM,
      platformId: id,
      title,
      url: canonicalUrl(id),
    };
    if (slot && slot.sidebarIndex != null) conv.sidebarIndex = slot.sidebarIndex;
    Chatseek.attachPageTime(conv, a, times, sectionMap);
    return conv;
  }

  function extractArchivedList(doc, archiveRoot) {
    if (!archiveRoot) return [];
    const root = doc || document;
    const byId = new Map();
    const times = jsonTimes(root);
    const anchors = [];
    archiveRoot.querySelectorAll('a[href*="/c/"]').forEach((a) => {
      const id = Chatseek.uuidFrom(a.getAttribute("href") || a.href);
      if (!id) return;
      anchors.push(a);
    });
    const sectionMap = Chatseek.sectionTimesFor(anchors);
    for (const a of anchors) {
      const conv = rowFromAnchor(a, times, sectionMap, null);
      if (!conv) continue;
      conv.archived = true;
      conv.archiveSource = "chatgpt:archive-list";
      delete conv.sidebarIndex;
      Chatseek.rememberConv(byId, conv);
    }
    return [...byId.values()];
  }

  function extractSidebar(doc, archiveRoot) {
    const root = doc || document;
    const byId = new Map();
    const times = jsonTimes(root);
    const anchors = [];
    root.querySelectorAll('a[href*="/c/"]').forEach((a) => {
      if (archiveRoot && archiveRoot.contains(a)) return;
      const id = Chatseek.uuidFrom(a.getAttribute("href") || a.href);
      if (!id) return;
      anchors.push(a);
    });
    const sectionMap = Chatseek.sectionTimesFor(anchors);
    for (const slot of Chatseek.sidebarSlots(anchors)) {
      const conv = rowFromAnchor(slot.el, times, sectionMap, slot);
      if (!conv) continue;
      Chatseek.rememberConv(byId, conv);
    }
    return [...byId.values()];
  }

  function dropNested(nodes) {
    return nodes.filter((node) => {
      if (Chatseek.isMessageChrome(node)) return false;
      const links = node.querySelectorAll('a[href*="/c/"]');
      if (links.length >= 3) return false;
      return !nodes.some((other) => other !== node && node.contains(other));
    });
  }

  function bodyOf(node) {
    const markdown = node.querySelector(".markdown, .prose");
    const pre = node.querySelector(".whitespace-pre-wrap");
    return Chatseek.textOf(markdown) || Chatseek.textOf(pre) || Chatseek.cleanClone(node);
  }

  function keptNodes(root, layer) {
    let found = [];
    try {
      found = [...root.querySelectorAll(layer.selector)];
    } catch {
      found = [];
    }
    return dropNested(found);
  }

  function extractMessages(conversationId, doc) {
    const root = doc || document;
    const selectorsTried = MESSAGE_LAYERS.map((layer) => layer.name);
    let selector = null;
    let nodes = [];
    const pick = (scope) => {
      for (const layer of MESSAGE_LAYERS) {
        const kept = keptNodes(scope, layer);
        if (!kept.length) continue;
        selector = layer.name;
        nodes = kept;
        return true;
      }
      return false;
    };
    if (!pick(root)) {
      for (const shadowRoot of Chatseek.openShadowRoots(root)) {
        if (pick(shadowRoot)) break;
      }
    }
    const messages = [];
    nodes.forEach((node) => {
      const role = Chatseek.messageRole(node);
      if (role === "system" || role === "tool") return;
      const heading = Chatseek.textOf(node.querySelector("h5, h6"));
      const resolved = role === "assistant" || role === "user"
        ? role
        : (/^chatgpt/i.test(heading) ? "assistant" : "user");
      const platformMessageId = node.getAttribute("data-message-id") ||
        node.querySelector("[data-message-id]")?.getAttribute("data-message-id") ||
        Chatseek.hash(resolved + ":" + Chatseek.textOf(node).slice(0, 180));
      const body = bodyOf(node);
      if (!body || Chatseek.isUiNoise(body)) return;
      messages.push({
        id: `${PLATFORM}:${conversationId}:${platformMessageId}`,
        role: resolved,
        body,
      });
    });
    return { messages, selector, selectorsTried };
  }

  function healthFor(loc, doc, extraction, sidebar, platformId) {
    return {
      pathKind: Chatseek.pageKind(loc || location, !!platformId),
      selector: extraction?.selector || null,
      selectorsTried: extraction?.selectorsTried || MESSAGE_LAYERS.map((layer) => layer.name),
      sidebar,
    };
  }

  function markSeenActive(conv, source) {
    conv.archived = false;
    conv.archiveSource = source;
    return conv;
  }

  async function capture(doc, loc) {
    const root = doc || document;
    const here = loc || location;
    const signals = Chatseek.readArchiveSignals(root, here, PLATFORM);
    const sidebar = extractSidebar(root, signals.archiveRoot).map((conv) =>
      markSeenActive(conv, "chatgpt:sidebar"),
    );
    const archivedRows = extractArchivedList(root, signals.archiveRoot);
    const temporary = Chatseek.pageKind(here, false) === "temporary";
    const platformId = temporary ? null : conversationIdFromLocation(here);
    let conversation = null;
    let extracted = { messages: [], selector: null, selectorsTried: MESSAGE_LAYERS.map((l) => l.name) };
    if (platformId) {
      const fromSidebar = sidebar.find((c) => c.platformId === platformId);
      const title = titleFromDoc(root) || fromSidebar?.title || platformId;
      conversation = {
        id: `${PLATFORM}:${platformId}`,
        platform: PLATFORM,
        platformId,
        title,
        url: canonicalUrl(platformId),
      };
      Chatseek.applyStoredTime(conversation, fromSidebar, jsonTimes(root));
      // The live sidebar is a non-archived context and wins over a stale banner.
      // A banner or archive-list-only view is the explicit archived signal.
      if (fromSidebar) markSeenActive(conversation, "chatgpt:sidebar");
      else if (signals.banner) {
        conversation.archived = true;
        conversation.archiveSource = "chatgpt:banner";
      } else if (archivedRows.some((row) => row.platformId === platformId)) {
        conversation.archived = true;
        conversation.archiveSource = "chatgpt:archive-list";
      } else markSeenActive(conversation, "chatgpt:conversation");
      extracted = extractMessages(platformId, root);
    }
    return Chatseek.runCapture(state, {
      platform: PLATFORM,
      sidebar,
      archivedRows,
      conversation,
      messages: extracted.messages,
      health: {
        pathKind: Chatseek.pageKind(here, !!platformId),
        selector: extracted.selector,
        selectorsTried: extracted.selectorsTried,
      },
    });
  }

  function inspect(doc, loc) {
    const root = doc || document;
    const here = loc || location;
    const platformId = conversationIdFromLocation(here);
    const sidebar = extractSidebar(root);
    const extracted = platformId
      ? extractMessages(platformId, root)
      : { messages: [], selector: null, selectorsTried: MESSAGE_LAYERS.map((l) => l.name) };
    const health = Chatseek.buildHealthReport({
      platform: PLATFORM,
      pathKind: Chatseek.pageKind(here, !!platformId && !/[?&]temporary-chat=true(?:&|$)/.test(here.search || "")),
      sidebarCount: sidebar.length,
      messageCount: extracted.messages.length,
      selector: extracted.selector,
      selectorsTried: extracted.selectorsTried,
    });
    if (/[?&]temporary-chat=true(?:&|$)/.test(here.search || "")) {
      health.pathKind = "temporary";
      health.warn = false;
    }
    return { sidebar, ...extracted, health, platformId };
  }

  Chatseek.platforms = Chatseek.platforms || {};
  Chatseek.platforms.chatgpt = {
    messageLayers: MESSAGE_LAYERS,
    extractMessages,
    extractSidebar,
    inspect,
    capture,
    healthFor,
  };

  if (Chatseek.autoStart !== false) Chatseek.observe(() => capture());
})();
