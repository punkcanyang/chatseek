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
    return Chatseek.conversationIdFromPath((loc || location).pathname || "");
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
    const id = Chatseek.conversationIdFromPath(a.getAttribute("href") || a.href);
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
      const id = Chatseek.conversationIdFromPath(a.getAttribute("href") || a.href);
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
      const id = Chatseek.conversationIdFromPath(a.getAttribute("href") || a.href);
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

  function turnOf(node) {
    return node?.closest?.("[data-turn], article, [data-testid*='conversation-turn']") || node;
  }

  function consider(node, layer, chosen) {
    if (chosen.some((item) => item.node === node || item.node.contains(node))) return false;
    const built = messageFromNode(node, chosen.conversationId);
    if (!built) return false;
    const inners = chosen.filter((item) => node.contains(item.node) && item.node !== node);
    if (inners.length > 1) return false;
    if (inners.length === 1) {
      const inner = inners[0].message.body;
      const outer = built.message.body;
      if (outer.length < inner.length + 24 || !outer.includes(inner.slice(0, Math.min(80, inner.length)))) {
        return false;
      }
      const idx = chosen.indexOf(inners[0]);
      if (idx >= 0) chosen.splice(idx, 1);
    }
    const turn = turnOf(node);
    const dup = chosen.find((item) => {
      if (turnOf(item.node) !== turn) return false;
      const prev = item.message.body.trim();
      const next = built.message.body.trim();
      return prev === next || (prev.length > next.length && prev.includes(next));
    });
    if (dup) return false;
    chosen.push({ node, ...built, layer: layer.name });
    return true;
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
        if (consider(node, layer, chosen) && !selector) selector = layer.name;
      }
    }
    return selector;
  }

  async function takeLayerPaced(scope, chosen) {
    let selector = null;
    for (const layer of MESSAGE_LAYERS) {
      for (const node of keptNodes(scope, layer)) {
        if (consider(node, layer, chosen) && !selector) selector = layer.name;
        await Chatseek.paceDom();
      }
    }
    return selector;
  }

  function packMessages(chosen, selector, selectorsTried, selectorHits) {
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

  function scopeLabel(scope, got) {
    if (!got) return null;
    if (!scope || scope.kind === "top") return got;
    return `${scope.kind} ${got}`;
  }

  function noteScopeHits(selectorHits, scope) {
    if (!scope || scope.kind === "top") return;
    const hits = Chatseek.countSelectors(scope.node, MESSAGE_LAYERS);
    const prefix = scope.kind === "iframe" ? "iframe" : "shadow";
    for (const [name, count] of Object.entries(hits)) {
      if (!count) continue;
      const key = `${prefix} ${name}`;
      selectorHits[key] = (selectorHits[key] || 0) + count;
    }
  }

  function heuristicFromBlock(block, conversationId) {
    const role = block?.role === "user" || block?.role === "assistant" ? block.role : "unknown";
    const rendered = Chatseek.safeDomText(block.el, role === "user");
    const body = rendered.text;
    if (!Chatseek.isSubstantive(body) || String(body).trim().length < 24) return null;
    const platformMessageId = Chatseek.hash(role + ":" + body.slice(0, 180));
    const id = `${PLATFORM}:${conversationId}:${platformMessageId}`;
    return {
      node: block.el,
      layer: "heuristic",
      message: { id, role, body },
      host: { el: block.el, messageId: id, role, body, offsets: rendered.offsets },
    };
  }

  function takeHeuristic(scopes, chosen, conversationId) {
    if (chosen.length) return null;
    for (const block of Chatseek.heuristicBlocks(scopes)) {
      const built = heuristicFromBlock(block, conversationId);
      if (built) chosen.push(built);
    }
    return chosen.length ? "heuristic" : null;
  }

  function extractMessages(conversationId, doc) {
    const root = doc || document;
    const selectorsTried = MESSAGE_LAYERS.map((layer) => layer.name);
    const selectorHits = Chatseek.countSelectors(root, MESSAGE_LAYERS);
    const scopes = Chatseek.readScopes(root);
    imageHosts = [];
    const chosen = [];
    chosen.conversationId = conversationId;
    let selector = null;
    for (const scope of scopes) {
      noteScopeHits(selectorHits, scope);
      const got = takeLayer(scope.node, chosen);
      if (chosen.length) {
        selector = scopeLabel(scope, got);
        break;
      }
    }
    if (!chosen.length) selector = takeHeuristic(scopes, chosen, conversationId);
    return packMessages(chosen, selector, selectorsTried, selectorHits);
  }

  async function extractMessagesPaced(conversationId, doc) {
    const root = doc || document;
    const selectorsTried = MESSAGE_LAYERS.map((layer) => layer.name);
    const selectorHits = Chatseek.countSelectors(root, MESSAGE_LAYERS);
    const scopes = Chatseek.readScopes(root);
    imageHosts = [];
    const chosen = [];
    chosen.conversationId = conversationId;
    Chatseek._paceAt = Date.now();
    let selector = null;
    for (const scope of scopes) {
      noteScopeHits(selectorHits, scope);
      const got = await takeLayerPaced(scope.node, chosen);
      if (chosen.length) {
        selector = scopeLabel(scope, got);
        break;
      }
      await Chatseek.paceDom();
    }
    if (!chosen.length) selector = takeHeuristic(scopes, chosen, conversationId);
    return packMessages(chosen, selector, selectorsTried, selectorHits);
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
    let titled = "";
    let extracted = {
      messages: [],
      selector: null,
      selectorsTried: MESSAGE_LAYERS.map((l) => l.name),
      selectorHits: Chatseek.countSelectors(root, MESSAGE_LAYERS),
    };
    if (platformId) {
      const fromSidebar = sidebar.find((c) => c.platformId === platformId);
      titled = titleFromDoc(root) || fromSidebar?.title || "";
      const title = titled || platformId;
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
      extracted = await extractMessagesPaced(platformId, root);
    }
    const stats = Chatseek.messageStats(extracted.messages);
    const pathKind = Chatseek.pageKind(here, !!platformId);
    const structure = Chatseek.structureDiag(root);
    if (typeof Chatseek.noteEmptyConversation === "function") {
      Chatseek.noteEmptyConversation(pathKind === "conversation" && !extracted.messages.length);
    }
    const result = await Chatseek.runCapture(state, {
      platform: PLATFORM,
      sidebar,
      archivedRows,
      conversation,
      messages: extracted.messages,
      health: {
        pathKind,
        selector: extracted.selector,
        selectorsTried: extracted.selectorsTried,
        selectorHits: extracted.selectorHits,
        untitled: !!titled && Chatseek.isGenericTitle(titled),
        structure,
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
    const structure = Chatseek.structureDiag(root);
    health.structure = structure;
    return { sidebar, ...extracted, health, platformId, structure };
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

  if (Chatseek.autoStart !== false) {
    let child = false;
    try { child = window.top !== window; } catch { child = true; }
    if (child) Chatseek.watchChildFrame();
    else Chatseek.observe(() => capture());
  }
})();
