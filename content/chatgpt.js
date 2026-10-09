(() => {
  const PLATFORM = "chatgpt";
  const state = { lastListFp: "", lastMsgFp: "" };
  let cachedJsonTimes = null;
  let cachedJsonAt = 0;
  // Keep a live DOM turn's identity when its wording changes. Weak keys never
  // retain a removed website node. Conversation/role scope prevents SPA reuse
  // from carrying an id into another thread.
  const liveTurnIds = new WeakMap();
  let liveTurnSequence = 0;
  let previousPage = null;

  function messageIdFor(node, conversationId, role, body) {
    const explicit = node.getAttribute("data-message-id") ||
      node.querySelector("[data-message-id]")?.getAttribute("data-message-id") ||
      node.getAttribute("data-turn-id");
    if (explicit) return `${PLATFORM}:${conversationId}:${explicit}`;
    const host = turnOf(node);
    const scope = `${conversationId}:${role}`;
    const previous = liveTurnIds.get(host);
    if (previous?.scope === scope) return previous.id;
    const id = `${PLATFORM}:${conversationId}:${Chatseek.hash(role + ":" + body.slice(0, 180))}:dom${++liveTurnSequence}`;
    liveTurnIds.set(host, { scope, id });
    return id;
  }

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

  function archiveContains(archiveRoot, el) {
    const roots = Array.isArray(archiveRoot) ? archiveRoot : (archiveRoot ? [archiveRoot] : []);
    return roots.some((node) => node?.contains?.(el));
  }

  function extractSidebar(doc, archiveRoot) {
    const root = doc || document;
    const byId = new Map();
    const times = jsonTimes(root);
    const anchors = [];
    root.querySelectorAll('a[href*="/c/"]').forEach((a) => {
      if (archiveContains(archiveRoot, a)) return;
      const id = Chatseek.conversationIdFromPath(a.getAttribute("href") || a.href);
      if (!id) return;
      anchors.push(a);
    });
    const sectionMap = Chatseek.sectionTimesFor(anchors);
    for (const slot of Chatseek.sidebarSlots(anchors)) {
      const conv = rowFromAnchor(slot.el, times, sectionMap, slot);
      if (!conv) continue;
      Chatseek.rememberConv(byId, conv);
    }
    // Sidebar presence is not evidence. A listed chat stays whatever the
    // index already stored; disappearing from the sidebar is not archive.
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
    const body = settledBody(rendered, node, resolved);
    if (!Chatseek.isSubstantive(body)) return null;
    const id = messageIdFor(node, conversationId, resolved, body);
    // A live image-generation status turn. It must not be stored (or get a
    // fresh hash id) on every percentage change; runCapture drops it until it
    // settles into real content or disappears.
    const progress = resolved === "assistant" && Chatseek.isProgressMessage(body, node);
    return {
      message: { id, role: resolved, body, progress },
      host: { el: node, messageId: id, role: resolved, body, offsets: rendered.offsets, progress },
    };
  }

  function settledBody(rendered, node, role) {
    // Images do not add text in domText(). Keep an image-only turn and discard
    // its stale status line once a real image appears; offsets follow the new
    // body without changing the website DOM.
    if (role !== "user" && Chatseek._hasContentImage(node) &&
        (!rendered.text.trim() || Chatseek.isProgressText(rendered.text))) {
      for (const image of rendered.offsets.keys()) rendered.offsets.set(image, 0);
      return "🖼";
    }
    return rendered.text;
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

  function packMessages(chosen, selector, selectorsTried, selectorHits, collectImages = true) {
    chosen.sort((a, b) => {
      if (!a.node.compareDocumentPosition) return 0;
      const pos = a.node.compareDocumentPosition(b.node);
      if (pos & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
      if (pos & Node.DOCUMENT_POSITION_PRECEDING) return 1;
      return 0;
    });
    // React may replace the element while keeping the same turn position.
    // Reuse that slot only in an equally sized window with an unchanged
    // neighbour at the same position. Shifted/partial windows need new ids.
    const previous = previousPage?.conversationId === chosen.conversationId
      ? previousPage.messages : null;
    if (previous?.length === chosen.length) {
      const anchored = chosen.some((item, index) => {
        const before = previous[index];
        return before.role === item.message.role &&
          (before.id === item.message.id || before.body === item.message.body);
      });
      if (anchored) {
        const ids = new Set(chosen.map(item => item.message.id));
        for (let index = 0; index < chosen.length; index++) {
          const item = chosen[index];
          const before = previous[index];
          if (before.role !== item.message.role || ids.has(before.id) ||
              !/:dom\d+$/.test(before.id) || !/:dom\d+$/.test(item.message.id)) continue;
          item.message.id = before.id;
          item.host.messageId = before.id;
          liveTurnIds.set(turnOf(item.node), {
            scope: `${chosen.conversationId}:${item.message.role}`, id: before.id,
          });
        }
      }
    }
    previousPage = {
      conversationId: chosen.conversationId,
      messages: chosen.map(item => ({ ...item.message })),
    };
    const messages = [];
    for (const item of chosen) {
      messages.push(item.message);
      // A progress-only turn has no image yet; scheduling its host would only
      // re-scan a bubble that is about to be replaced.
      if (collectImages && !item.message.progress) imageHosts.push(item.host);
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
    const body = settledBody(rendered, block.el, role);
    if (!Chatseek.isSubstantive(body) ||
        (String(body).trim().length < 24 && !Chatseek._hasContentImage(block.el))) return null;
    const id = messageIdFor(block.el, conversationId, role, body);
    // Unknown heuristic roles are stored as assistant, so use the same status
    // rule here. Explicit user turns are always preserved.
    const progress = role !== "user" && Chatseek.isProgressMessage(body, block.el);
    return {
      node: block.el,
      layer: "heuristic",
      message: { id, role, body, progress },
      host: { el: block.el, messageId: id, role, body, offsets: rendered.offsets, progress },
    };
  }

  function rememberHeuristic(chosen, built, seen) {
    if (!built) return;
    const key = `${built.message.role}:${built.message.body}`;
    if (seen.has(key)) return;
    seen.add(key);
    chosen.push(built);
  }

  function takeHeuristic(scopes, chosen, conversationId) {
    if (chosen.length) return null;
    const seen = new Set();
    for (const block of Chatseek.heuristicBlocks(scopes)) {
      rememberHeuristic(chosen, heuristicFromBlock(block, conversationId), seen);
    }
    return chosen.length ? "heuristic" : null;
  }

  async function takeHeuristicPaced(scopes, chosen, conversationId) {
    if (chosen.length) return null;
    const blocks = await Chatseek.heuristicBlocksPaced(scopes);
    const seen = new Set();
    for (let index = 0; index < blocks.length; index += 1) {
      if ((index & 7) === 7) await Chatseek.paceDom();
      rememberHeuristic(chosen, heuristicFromBlock(blocks[index], conversationId), seen);
    }
    return chosen.length ? "heuristic" : null;
  }

  function extractMessages(conversationId, doc, collectImages = true) {
    const root = doc || document;
    const selectorsTried = MESSAGE_LAYERS.map((layer) => layer.name);
    const selectorHits = Chatseek.countSelectors(root, MESSAGE_LAYERS);
    const scopes = Chatseek.readScopes(root);
    if (collectImages) imageHosts = [];
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
    return packMessages(chosen, selector, selectorsTried, selectorHits, collectImages);
  }

  async function extractMessagesPaced(conversationId, doc) {
    const root = doc || document;
    const selectorsTried = MESSAGE_LAYERS.map((layer) => layer.name);
    const selectorHits = Chatseek.countSelectors(root, MESSAGE_LAYERS);
    imageHosts = [];
    const chosen = [];
    chosen.conversationId = conversationId;
    Chatseek._paceAt = Date.now();
    // Matched top-level turns skip the shadow and iframe walk.
    let selector = await takeLayerPaced(root, chosen);
    const scopes = [{ kind: "top", node: root }];
    if (!chosen.length) {
      const embedded = await Chatseek.readEmbeddedPaced(root);
      for (const scope of embedded) {
        scopes.push(scope);
        noteScopeHits(selectorHits, scope);
        const got = await takeLayerPaced(scope.node, chosen);
        if (chosen.length) {
          selector = scopeLabel(scope, got);
          break;
        }
        await Chatseek.paceDom();
      }
    }
    if (!chosen.length) selector = await takeHeuristicPaced(scopes, chosen, conversationId);
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

  function markArchived(conv, source) {
    conv.archived = true;
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
    const sidebar = extractSidebar(root, signals.archiveRoots);
    const archivedRows = [];
    const seenArchived = new Set();
    for (const archiveRoot of signals.archiveRoots || []) {
      for (const row of extractArchivedList(root, archiveRoot)) {
        if (seenArchived.has(row.platformId)) continue;
        seenArchived.add(row.platformId);
        archivedRows.push(row);
      }
    }
    const temporary = Chatseek.pageKind(here, false) === "temporary";
    const platformId = temporary ? null : conversationIdFromLocation(here);
    let conversation = null;
    let restoreOnNewMessages = false;
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
      // A banner or an archive-list link is the explicit archived signal.
      // Sidebar presence and a composer do not restore the chat. A later
      // new message on a page with no banner is the only capture-side restore.
      const listedHere = archivedRows.some((row) => row.platformId === platformId);
      if (signals.banner) markArchived(conversation, "chatgpt:banner");
      else if (listedHere) markArchived(conversation, "chatgpt:archive-list");
      else restoreOnNewMessages = () => {
        // Extraction and storage yield to the page. Recheck immediately before
        // restoring so a late banner/list or SPA navigation cannot clear it.
        if (conversationIdFromLocation(here) !== platformId) return false;
        const current = Chatseek.readArchiveSignals(root, here, PLATFORM);
        return !current.banner && !current.archiveRoots.some((node) =>
          Chatseek._archiveListIds(node).includes(platformId));
      };
      extracted = await extractMessagesPaced(platformId, root);
    }
    const stats = Chatseek.messageStats(extracted.messages);
    const pathKind = Chatseek.pageKind(here, !!platformId);
    const selectorName = extracted.selector || "";
    const structure = !extracted.messages.length || /shadow|iframe|heuristic/.test(selectorName)
      ? await Chatseek.structureDiagPaced(root)
      : Chatseek.structureDiagLight(root, stats.charCount);
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
        archiveBanner: signals.bannerHits,
        archiveList: signals.listHits,
        ...stats,
      },
      restoreOnNewMessages,
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

  Chatseek.syncProbe = () => {
    const signals = Chatseek.syncPageSignals(document, location);
    const sidebar = extractSidebar(document);
    const platformId = conversationIdFromLocation(location);
    let messageCount = 0;
    if (platformId) {
      try {
        const extracted = extractMessages(platformId, document, false);
        messageCount = extracted?.messages?.length || 0;
      } catch {
        messageCount = 0;
      }
    }
    const storedCount = platformId ? Chatseek.syncStoredCount(`${PLATFORM}:${platformId}`) : 0;
    return Chatseek.syncProbeResult(signals, sidebar, messageCount, storedCount);
  };

  if (Chatseek.autoStart !== false) {
    let child = false;
    try { child = window.top !== window; } catch { child = true; }
    if (child) Chatseek.watchChildFrame();
    else {
      Chatseek.watchEmbedded = true;
      Chatseek.observe(() => capture());
    }
  }
})();
