(() => {
  const PLATFORM = "claude";
  // claude.ai has no conversation archive banner or archived-chat list.
  // Project archive is a different object. Do not mark chats archived.
  const state = { lastListFp: "", lastMsgFp: "" };
  const MESSAGE_SELECTORS = [
    '[data-testid="user-message"]',
    '[data-testid="human-message"]',
    '[data-testid="assistant-message"]',
    '[data-testid="ai-message"]',
    ".font-claude-message",
  ];
  let cachedJsonTimes = null;
  let cachedJsonAt = 0;

  function canonicalUrl(id) {
    return `https://claude.ai/chat/${id}`;
  }

  function conversationIdFromLocation() {
    const path = location.pathname || "";
    if (!/\/chat\//.test(path)) return null;
    return Chatseek.uuidFrom(path);
  }

  function titleFromDoc() {
    return Chatseek.stripTitleSuffix(document.title, ["Claude"]);
  }

  function jsonTimes() {
    const now = Date.now();
    if (!cachedJsonTimes || now - cachedJsonAt > 15000) {
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

  async function extractMessages(conversationId) {
    imageHosts = [];
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
    Chatseek._paceAt = Date.now();
    for (const item of candidates) {
      if (seen.has(item.el)) continue;
      let nested = false;
      for (const other of candidates) {
        if (other.el !== item.el && other.el.contains(item.el)) nested = true;
      }
      if (nested) continue;
      seen.add(item.el);
      const rendered = Chatseek.safeDomText(item.el, item.role === "user");
      const body = rendered.text;
      await Chatseek.paceDom();
      if (!Chatseek.isSubstantive(body)) continue;
      const domId = item.el.getAttribute("data-message-id") ||
        item.el.id ||
        Chatseek.hash(item.role + ":" + body.slice(0, 180));
      const id = `${PLATFORM}:${conversationId}:${domId}`;
      messages.push({
        id,
        role: item.role,
        body,
      });
      imageHosts.push({ el: item.el, messageId: id, role: item.role, body, offsets: rendered.offsets });
    }
    return messages;
  }

  async function capture() {
    const sidebar = extractSidebar();
    const platformId = conversationIdFromLocation();
    let conversation = null;
    let messages = [];
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
      messages = await extractMessages(platformId);
    }
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
    if (conversation) {
      Chatseek.safeScheduleImages({
        conversationId: conversation.id,
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
        const messages = await extractMessages(platformId);
        messageCount = Array.isArray(messages) ? messages.length : 0;
      } catch {
        messageCount = 0;
      }
    }
    const storedCount = platformId ? Chatseek.syncStoredCount(`${PLATFORM}:${platformId}`) : 0;
    return Chatseek.syncProbeResult(signals, sidebar, messageCount, storedCount);
  };

  Chatseek.observe(capture);
})();
