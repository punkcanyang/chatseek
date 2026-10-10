(() => {
  const PLATFORM = "claude";
  // claude.ai has no conversation archive banner or archived-chat list.
  // Project archive is a different object. Do not mark chats archived.
  const state = { lastListFp: "", lastMsgFp: "" };
  const turnIdentity = Chatseek.createTurnIdentity(PLATFORM);
  const MESSAGE_SELECTORS = [
    '[data-testid="user-message"]',
    '[data-testid="human-message"]',
    '[data-testid="assistant-message"]',
    '[data-testid="ai-message"]',
    ".font-claude-message",
  ];
  let cachedJsonTimes = null;
  let cachedJsonAt = 0;
  let cachedJsonHref = "";

  function canonicalUrl(id) {
    return `https://claude.ai/chat/${id}`;
  }

  function conversationIdFromLocation(raw = location.href) {
    let path;
    try { path = new URL(raw, location.href).pathname; } catch { return null; }
    if (!/\/chat\//.test(path)) return null;
    return Chatseek.uuidFrom(path);
  }

  function titleFromDoc() {
    return Chatseek.stripTitleSuffix(document.title, ["Claude"]);
  }

  function jsonTimes() {
    const now = Date.now();
    if (!cachedJsonTimes || cachedJsonHref !== location.href || now - cachedJsonAt > 15000) {
      cachedJsonHref = location.href;
      cachedJsonTimes = Chatseek.pageTimesFromDocument();
      cachedJsonAt = now;
    }
    return cachedJsonTimes;
  }

  function extractSidebar() {
    const byId = new Map();
    const times = jsonTimes();
    const anchors = [];
    document.querySelectorAll('a[href*="/chat/"]').forEach((a) => {
      const href = a.getAttribute("href") || a.href || "";
      if (/\/chat\/new\b/i.test(href)) return;
      const id = Chatseek.uuidFrom(href);
      if (!id) return;
      anchors.push(a);
    });
    const sectionMap = Chatseek.sectionTimesFor(anchors);
    for (const slot of Chatseek.sidebarSlots(anchors)) {
      const a = slot.el;
      const href = a.getAttribute("href") || a.href || "";
      const id = Chatseek.uuidFrom(href);
      if (!id) continue;
      const title = Chatseek.textOf(a);
      if (!title) continue;
      const conv = {
        id: `${PLATFORM}:${id}`,
        platform: PLATFORM,
        platformId: id,
        title,
        url: canonicalUrl(id),
      };
      if (slot.sidebarIndex != null) conv.sidebarIndex = slot.sidebarIndex;
      Chatseek.attachPageTime(conv, a, times, sectionMap);
      Chatseek.rememberConv(byId, conv);
    }
    return [...byId.values()];
  }

  let imageHosts = [];

  function extractMessages(conversationId, collectImages = true, pace = true) {
    if (collectImages) imageHosts = [];
    const candidates = [];
    document
      .querySelectorAll(
        '[data-testid="user-message"], [data-testid="human-message"]',
      )
      .forEach((el) => {
        candidates.push({ el, role: "user" });
      });
    document
      .querySelectorAll(
        '[data-testid="assistant-message"], [data-testid="ai-message"]',
      )
      .forEach((el) => {
        candidates.push({ el, role: "assistant" });
      });
    document.querySelectorAll(".font-claude-message").forEach((el) => {
      if (
        el.closest(
          '[data-testid="user-message"], [data-testid="human-message"]',
        )
      ) {
        return;
      }
      candidates.push({ el, role: "assistant" });
    });

    candidates.sort((a, b) => {
      const pos = a.el.compareDocumentPosition(b.el);
      if (pos & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
      if (pos & Node.DOCUMENT_POSITION_PRECEDING) return 1;
      return 0;
    });

    const seen = new Set();
    const messages = [];
    const nodes = [];
    const pushItem = item => {
      if (seen.has(item.el)) return;
      let nested = false;
      for (const other of candidates) {
        if (other.el !== item.el && other.el.contains(item.el)) nested = true;
      }
      if (nested) return;
      seen.add(item.el);
      const rendered = Chatseek.safeDomText(item.el, item.role === "user");
      const body = rendered.text;
      if (!Chatseek.isSubstantive(body)) return;
      const domId = item.el.getAttribute("data-message-id") ||
        item.el.id;
      const id = turnIdentity(item.el, conversationId, item.role, body, domId);
      messages.push({
        id,
        role: item.role,
        body,
        turnId: id,
      });
      nodes.push(item.el);
      if (collectImages) imageHosts.push({ el: item.el, messageId: id, role: item.role, body, offsets: rendered.offsets });
    };
    if (!pace) {
      for (const item of candidates) pushItem(item);
      return { messages, nodes };
    }
    return (async () => {
      Chatseek._paceAt = Date.now();
      for (const item of candidates) { pushItem(item); await Chatseek.paceDom(); }
      return { messages, nodes };
    })();
  }

  async function capture() {
    const captureHref = location.href;
    const sidebar = extractSidebar();
    const platformId = conversationIdFromLocation();
    let conversation = null;
    let messages = [];
    let extracted = { messages: [], nodes: [] };
    let titled = "";
    if (platformId) {
      const fromSidebar = sidebar.find((c) => c.platformId === platformId);
      titled = titleFromDoc() || fromSidebar?.title || "";
      const title = titled || platformId;
      conversation = {
        id: `${PLATFORM}:${platformId}`,
        platform: PLATFORM,
        platformId,
        title,
        url: canonicalUrl(platformId),
      };
      Chatseek.applyStoredTime(conversation, fromSidebar, jsonTimes());
      const initial = extractMessages(platformId, false, false);
      if (initial.messages.length || state.pageIdentity) Chatseek.pageIdentity(state, document, captureHref, platformId, initial, conversationIdFromLocation);
      extracted = await extractMessages(platformId);
      messages = extracted.messages;
    }
    if (location.href !== captureHref) return false;
    const identity = platformId && (messages.length || state.pageIdentity)
      ? Chatseek.pageIdentity(state, document, captureHref, platformId, extracted, conversationIdFromLocation) : null;
    if (identity?.check()) identity.accept();
    const selectorHits = {};
    let selector = null;
    for (const sel of MESSAGE_SELECTORS) {
      let n = 0;
      try { n = document.querySelectorAll(sel).length; } catch { n = 0; }
      selectorHits[sel] = n;
      if (!selector && n) selector = sel;
    }
    const stats = Chatseek.messageStats(messages);
    let result = false;
    try {
      result = await Chatseek.runCapture(state, {
        platform: PLATFORM,
        sidebar,
        conversation,
        messages,
        identity,
        health: {
          pathKind: Chatseek.pageKind(location, !!platformId),
          selector,
          selectorsTried: MESSAGE_SELECTORS,
          selectorHits,
          untitled: !!titled && Chatseek.isGenericTitle(titled),
          ...stats,
        },
      });
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
    if (conversation && result && identity?.check()) {
      Chatseek.safeScheduleImages({
        conversationId: conversation.id,
        isCurrent: identity.check,
        items: imageHosts,
      });
    }
    return result;
  }

  Chatseek.syncProbe = async () => {
    const signals = Chatseek.syncPageSignals(document, location);
    const sidebar = extractSidebar();
    const platformId = conversationIdFromLocation();
    let messageCount = 0;
    if (platformId) {
      try {
        const extracted = await extractMessages(platformId, false);
        messageCount = extracted.messages.length;
      } catch {
        messageCount = 0;
      }
    }
    const storedCount = platformId ? Chatseek.syncStoredCount(`${PLATFORM}:${platformId}`) : 0;
    return Chatseek.syncProbeResult(signals, sidebar, messageCount, storedCount);
  };

  Chatseek.observe(capture);
})();
