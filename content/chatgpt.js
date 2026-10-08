(() => {
  const PLATFORM = "chatgpt";
  const state = { lastListFp: "", lastMsgFp: "" };
  let cachedJsonTimes = null;
  let cachedJsonAt = 0;

  // First hit wins. Later layers cover the late-2026 turn markup
  // (data-turn / conversation-turn / data-message-id) when the classic
  // data-message-author-role nodes are gone. A new adapter can pass its
  // own list to Chatseek.queryLayers instead of copying this walker.
  // Public ChatGPT markup, oldest first. A layer is kept only when it
  // yields prose. An empty data-message-author-role shell must not hide a
  // later turn that actually has the text.
  const MESSAGE_LAYERS = [
    { name: "[data-message-author-role]", selector: "[data-message-author-role]" },
    { name: "[data-turn]", selector: "[data-turn]" },
    { name: "[data-testid*=conversation-turn]", selector: "[data-testid*='conversation-turn']" },
    { name: "[data-turn-id]", selector: "[data-turn-id], [data-turn-id-container]" },
    { name: "[data-message-id]", selector: "[data-message-id]" },
    { name: "[data-message-content]", selector: "[data-message-content]" },
    { name: "[class*=conversation-turn]", selector: "[class*='conversation-turn']" },
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
    const liveIds = new Set();
    root.querySelectorAll('a[href*="/c/"]').forEach((a) => {
      if (archiveRoot && archiveRoot.contains(a)) return;
      const id = Chatseek.uuidFrom(a.getAttribute("href") || a.href);
      if (!id) return;
      anchors.push(a);
      if (Chatseek.inLiveSidebar(a, archiveRoot)) liveIds.add(id);
    });
    const sectionMap = Chatseek.sectionTimesFor(anchors);
    for (const slot of Chatseek.sidebarSlots(anchors)) {
      const conv = rowFromAnchor(slot.el, times, sectionMap, slot);
      if (!conv) continue;
      Chatseek.rememberConv(byId, conv);
    }
    const rows = [...byId.values()];
    // Only the live chat list says "not archived". A /c/ link in a message or
    // an unrecognised dialog is indexed but leaves the stored archive state alone.
    for (const conv of rows) {
      if (liveIds.has(conv.platformId)) markSeenActive(conv, "chatgpt:sidebar");
    }
    return rows;
  }

  function dropNested(nodes) {
    return nodes.filter((node) => {
      if (Chatseek.isMessageChrome(node)) return false;
      const links = node.querySelectorAll('a[href*="/c/"]');
      if (links.length >= 3) return false;
      return !nodes.some((other) => other !== node && node.contains(other));
    });
  }

  function bodyOf(node, role) {
    return Chatseek.safeDomText(node, role === "user");
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

  let imageHosts = [];

  function messageFromNode(node, conversationId) {
    const role = Chatseek.messageRole(node);
    if (role === "system" || role === "tool") return null;
    const heading = Chatseek.textOf(node.querySelector("h5, h6"));
    const resolved = role === "assistant" || role === "user"
      ? role
      : (/^chatgpt/i.test(heading) ? "assistant" : "user");
    const rendered = bodyOf(node, resolved);
    const body = rendered.text;
    if (!Chatseek.isSubstantive(body)) return null;
    const platformMessageId = node.getAttribute("data-message-id") ||
      node.querySelector("[data-message-id]")?.getAttribute("data-message-id") ||
      Chatseek.hash(resolved + ":" + body.slice(0, 180));
    const id = `${PLATFORM}:${conversationId}:${platformMessageId}`;
    return {
      message: { id, role: resolved, body },
      host: { el: node, messageId: id, role: resolved, body, offsets: rendered.offsets },
    };
  }

  function takeLayer(scope, chosen) {
    let selector = null;
    for (const layer of MESSAGE_LAYERS) {
      for (const node of keptNodes(scope, layer)) {
        if (chosen.some((item) => item.node === node || item.node.contains(node) || node.contains(item.node))) {
          continue;
        }
        const built = messageFromNode(node, chosen.conversationId);
        if (!built) continue;
        if (!selector) selector = layer.name;
        chosen.push({ node, ...built, layer: layer.name });
      }
    }
    return selector;
  }

  function extractMessages(conversationId, doc) {
    const root = doc || document;
    const selectorsTried = MESSAGE_LAYERS.map((layer) => layer.name);
    const selectorHits = Chatseek.countSelectors(root, MESSAGE_LAYERS);
    imageHosts = [];
    const chosen = [];
    chosen.conversationId = conversationId;
    let selector = takeLayer(root, chosen);
    if (!chosen.length) {
      for (const shadowRoot of Chatseek.openShadowRoots(root)) {
        const shadowHits = Chatseek.countSelectors(shadowRoot, MESSAGE_LAYERS);
        for (const [name, count] of Object.entries(shadowHits)) {
          if (count) selectorHits[`shadow ${name}`] = (selectorHits[`shadow ${name}`] || 0) + count;
        }
        const shadowSelector = takeLayer(shadowRoot, chosen);
        if (chosen.length) {
          selector = shadowSelector ? `shadow ${shadowSelector}` : selector;
          break;
        }
      }
    }
    chosen.sort((a, b) => {
      if (!a.node.compareDocumentPosition) return 0;
      const pos = a.node.compareDocumentPosition(b.node);
      if (pos & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
      if (pos & Node.DOCUMENT_POSITION_PRECEDING) return 1;
      return 0;
    });
    const messages = [];
    for (const item of chosen) {
      messages.push(item.message);
      imageHosts.push(item.host);
    }
    if (!selector && chosen[0]) selector = chosen[0].layer;
    return { messages, selector, selectorsTried, selectorHits };
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
    try {
      return await captureInner(doc, loc);
    } catch (err) {
      Chatseek.rememberError(err);
      Chatseek.publishDiag(Chatseek.diagFields({
        platform: PLATFORM,
        pathKind: "error",
        healthState: "error",
        at: Date.now(),
      }));
      return false;
    }
  }

  async function captureInner(doc, loc) {
    const root = doc || document;
    const here = loc || location;
    const signals = Chatseek.readArchiveSignals(root, here, PLATFORM);
    const sidebar = extractSidebar(root, signals.archiveRoot);
    const archivedRows = extractArchivedList(root, signals.archiveRoot);
    const temporary = Chatseek.pageKind(here, false) === "temporary";
    const platformId = temporary ? null : conversationIdFromLocation(here);
    let conversation = null;
    let extracted = {
      messages: [],
      selector: null,
      selectorsTried: MESSAGE_LAYERS.map((l) => l.name),
      selectorHits: Chatseek.countSelectors(root, MESSAGE_LAYERS),
    };
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
      // With neither a banner nor a composer the view proves nothing either way.
      if (fromSidebar?.archived === false) markSeenActive(conversation, "chatgpt:sidebar");
      else if (signals.banner) {
        conversation.archived = true;
        conversation.archiveSource = "chatgpt:banner";
      } else if (archivedRows.some((row) => row.platformId === platformId)) {
        conversation.archived = true;
        conversation.archiveSource = "chatgpt:archive-list";
      } else if (signals.composer) markSeenActive(conversation, "chatgpt:conversation");
      extracted = extractMessages(platformId, root);
    }
    const stats = Chatseek.messageStats(extracted.messages);
    const result = await Chatseek.runCapture(state, {
      platform: PLATFORM,
      sidebar,
      archivedRows,
      conversation,
      messages: extracted.messages,
      health: {
        pathKind: Chatseek.pageKind(here, !!platformId),
        selector: extracted.selector,
        selectorsTried: extracted.selectorsTried,
        selectorHits: extracted.selectorHits,
        ...stats,
      },
    });
    // Text is already stored. An image error must not reject this capture.
    if (conversation) {
      Chatseek.safeScheduleImages({
        conversationId: conversation.id,
        items: imageHosts,
      });
    }
    return result;
  }

  function inspect(doc, loc) {
    const root = doc || document;
    const here = loc || location;
    const platformId = conversationIdFromLocation(here);
    const sidebar = extractSidebar(root);
    const extracted = platformId
      ? extractMessages(platformId, root)
      : { messages: [], selector: null, selectorsTried: MESSAGE_LAYERS.map((l) => l.name) };
    const stats = Chatseek.messageStats(extracted.messages);
    const health = Chatseek.buildHealthReport({
      platform: PLATFORM,
      pathKind: Chatseek.pageKind(here, !!platformId && !/[?&]temporary-chat=true(?:&|$)/.test(here.search || "")),
      sidebarCount: sidebar.length,
      messageCount: extracted.messages.length,
      selector: extracted.selector,
      selectorsTried: extracted.selectorsTried,
      selectorHits: extracted.selectorHits,
      ...stats,
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
