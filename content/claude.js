(() => {
  const PLATFORM = "claude";
  let lastListFp = "";
  let lastMsgFp = "";

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

  function extractSidebar() {
    const byId = new Map();
    document.querySelectorAll('a[href*="/chat/"]').forEach((a) => {
      const href = a.getAttribute("href") || a.href || "";
      if (/\/chat\/new\b/i.test(href)) return;
      const id = Chatseek.uuidFrom(href);
      if (!id) return;
      const title = Chatseek.textOf(a);
      if (!title) return;
      byId.set(id, {
        id: `${PLATFORM}:${id}`,
        platform: PLATFORM,
        platformId: id,
        title,
        url: canonicalUrl(id),
      });
    });
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
    const listFp = Chatseek.fingerprint(
      sidebar.map((c) => c.id + ":" + c.title),
    );
    if (listFp && listFp !== lastListFp) {
      lastListFp = listFp;
      await Chatseek.send({
        type: "CAPTURE_CONVERSATIONS",
        platform: PLATFORM,
        conversations: sidebar,
      });
    }

    const platformId = conversationIdFromLocation();
    if (!platformId) return;

    const title = titleFromDoc() ||
      sidebar.find((c) => c.platformId === platformId)?.title ||
      platformId;
    const conversation = {
      id: `${PLATFORM}:${platformId}`,
      platform: PLATFORM,
      platformId,
      title,
      url: canonicalUrl(platformId),
    };
    const messages = extractMessages(platformId);
    const msgFp = Chatseek.fingerprint([
      conversation.id,
      conversation.title,
      ...messages.map((m) => m.id + ":" + m.body.length + ":" + m.body.slice(-80)),
    ]);
    if (msgFp === lastMsgFp) return;
    lastMsgFp = msgFp;

    if (sidebar.every((c) => c.platformId !== platformId)) {
      await Chatseek.send({
        type: "CAPTURE_CONVERSATIONS",
        platform: PLATFORM,
        conversations: [conversation],
      });
    }

    const chunk = 20;
    for (let i = 0; i < messages.length; i += chunk) {
      await Chatseek.send({
        type: "CAPTURE_MESSAGES",
        platform: PLATFORM,
        conversation,
        messages: messages.slice(i, i + chunk),
      });
    }
  }

  Chatseek.observe(capture);
})();
