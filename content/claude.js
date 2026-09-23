(() => {
  const PLATFORM = "claude";
  const state = { lastListFp: "", lastMsgFp: "" };
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
    return (document.title || "")
      .replace(/\s*[|·—-]\s*Claude.*$/i, "")
      .trim();
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
    for (const a of anchors) {
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
      Chatseek.attachPageTime(conv, a, times, sectionMap);
      Chatseek.rememberConv(byId, conv);
    }
    return [...byId.values()];
  }

  function extractMessages(conversationId) {
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
    candidates.forEach((item) => {
      if (seen.has(item.el)) return;
      for (const other of candidates) {
        if (other.el !== item.el && other.el.contains(item.el)) return;
      }
      seen.add(item.el);
      const body = Chatseek.cleanClone(item.el);
      if (!body) return;
      const domId = item.el.getAttribute("data-message-id") ||
        item.el.id ||
        Chatseek.hash(item.role + ":" + body.slice(0, 180));
      messages.push({
        id: `${PLATFORM}:${conversationId}:${domId}`,
        role: item.role,
        body,
      });
    });
    return messages;
  }

  async function capture() {
    const sidebar = extractSidebar();
    const platformId = conversationIdFromLocation();
    let conversation = null;
    let messages = [];
    if (platformId) {
      const fromSidebar = sidebar.find((c) => c.platformId === platformId);
      const title = titleFromDoc() || fromSidebar?.title || platformId;
      conversation = {
        id: `${PLATFORM}:${platformId}`,
        platform: PLATFORM,
        platformId,
        title,
        url: canonicalUrl(platformId),
      };
      if (fromSidebar?.updatedAt) {
        conversation.updatedAt = fromSidebar.updatedAt;
        conversation.createdAt = fromSidebar.createdAt || fromSidebar.updatedAt;
      } else {
        Chatseek.attachPageTime(conversation, null, jsonTimes());
      }
      messages = extractMessages(platformId);
    }
    await Chatseek.runCapture(state, {
      platform: PLATFORM,
      sidebar,
      conversation,
      messages,
    });
  }

  Chatseek.observe(capture);
})();
