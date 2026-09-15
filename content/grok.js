(() => {
  const PLATFORM = "grok";
  let lastListFp = "";
  let lastMsgFp = "";
  let cachedJsonTimes = null;
  let cachedJsonAt = 0;

  function canonicalUrl(id) {
    return `https://grok.com/c/${id}`;
  }

  function conversationIdFromLocation() {
    const path = location.pathname || "";
    // Current Grok uses /c/{uuid}; older builds used /chat/{uuid}.
    if (!/\/(c|chat)\//.test(path)) return null;
    return Chatseek.uuidFrom(path);
  }

  function titleFromDoc() {
    return (document.title || "")
      .replace(/\s*[|·—-]\s*(Grok|x\.ai|X).*$/i, "")
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
    document
      .querySelectorAll('a[href*="/c/"], a[href*="/chat/"]')
      .forEach((a) => {
        const href = a.getAttribute("href") || a.href || "";
        if (/^https?:/i.test(href) && !/grok\.com|x\.ai/i.test(href)) return;
        if (/\/chat\/new\b/i.test(href)) return;
        const id = Chatseek.uuidFrom(href);
        if (!id) return;
        const title = Chatseek.textOf(a);
        if (!title) return;
        const conv = {
          id: `${PLATFORM}:${id}`,
          platform: PLATFORM,
          platformId: id,
          title,
          url: canonicalUrl(id),
        };
        // Grok history uses sticky time-header buckets; rows may also have <time>.
        Chatseek.attachPageTime(conv, a, times);
        const prev = byId.get(id);
        if (!prev || (conv.updatedAt && (!prev.updatedAt || conv.updatedAt > prev.updatedAt))) {
          byId.set(id, conv);
        }
      });
    return [...byId.values()];
  }

  function roleFromNode(node) {
    const roleAttr = (
      node.getAttribute("data-message-author-role") ||
      node.getAttribute("data-role") ||
      ""
    ).toLowerCase();
    if (roleAttr === "user" || roleAttr === "human") return "user";
    if (
      roleAttr === "assistant" ||
      roleAttr === "ai" ||
      roleAttr === "grok" ||
      roleAttr === "model"
    ) {
      return "assistant";
    }

    const testId = (node.getAttribute("data-testid") || "").toLowerCase();
    const classList =
      typeof node.className === "string" ? node.className.toLowerCase() : "";
    const blob = `${testId} ${classList}`;
    if (/user|human|query|prompt/.test(blob)) return "user";
    if (/assistant|ai|grok|response|model/.test(blob)) return "assistant";

    let parent = node.parentElement;
    for (let i = 0; i < 3 && parent; i++) {
      const parentClass =
        typeof parent.className === "string"
          ? parent.className.toLowerCase()
          : "";
      const parentRole = (
        parent.getAttribute("data-message-author-role") ||
        parent.getAttribute("data-role") ||
        ""
      ).toLowerCase();
      if (
        parentRole === "user" ||
        parentRole === "human" ||
        /user|human|query/.test(parentClass)
      ) {
        return "user";
      }
      if (
        parentRole === "assistant" ||
        parentRole === "ai" ||
        parentRole === "grok" ||
        /assistant|ai|grok|response/.test(parentClass)
      ) {
        return "assistant";
      }
      parent = parent.parentElement;
    }
    return null;
  }

  function extractMessages(conversationId) {
    const candidates = [];
    const pushUnique = (el, role) => {
      if (!el || !role) return;
      if (candidates.some((c) => c.el === el)) return;
      candidates.push({ el, role });
    };

    document.querySelectorAll("[data-message-author-role]").forEach((el) => {
      pushUnique(el, roleFromNode(el) || "user");
    });

    if (!candidates.length) {
      document.querySelectorAll("[data-role]").forEach((el) => {
        const role = roleFromNode(el);
        if (role) pushUnique(el, role);
      });
    }

    if (!candidates.length) {
      document
        .querySelectorAll(
          '[data-testid*="message"], [role="article"], [class*="message"], [class*="Message"]',
        )
        .forEach((el) => {
          const classList =
            typeof el.className === "string" ? el.className.toLowerCase() : "";
          if (
            /sidebar|nav|header|footer|button|input|composer/.test(classList)
          ) {
            return;
          }
          pushUnique(el, roleFromNode(el));
        });
    }

    candidates.sort((a, b) => {
      const pos = a.el.compareDocumentPosition(b.el);
      if (pos & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
      if (pos & Node.DOCUMENT_POSITION_PRECEDING) return 1;
      return 0;
    });

    const seen = new Set();
    const messages = [];
    candidates.forEach((item, index) => {
      if (seen.has(item.el)) return;
      for (const other of candidates) {
        if (other.el !== item.el && other.el.contains(item.el)) return;
      }
      seen.add(item.el);
      const body = Chatseek.cleanClone(item.el);
      if (!body || body.length < 1) return;
      const role =
        item.role ||
        (messages.length
          ? messages[messages.length - 1].role === "user"
            ? "assistant"
            : "user"
          : index % 2 === 0
            ? "user"
            : "assistant");
      const platformMessageId = item.el.getAttribute("data-message-id") ||
        item.el.id ||
        Chatseek.hash(role + ":" + body.slice(0, 180));
      messages.push({
        id: `${PLATFORM}:${conversationId}:${platformMessageId}`,
        role,
        body,
      });
    });
    return messages;
  }

  async function capture() {
    const sidebar = extractSidebar();
    const listFp = Chatseek.fingerprint(
      sidebar.map((c) => c.id + ":" + c.title + ":" + (c.updatedAt || "")),
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

    const fromSidebar = sidebar.find((c) => c.platformId === platformId);
    const title = titleFromDoc() || fromSidebar?.title || platformId;
    const conversation = {
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

    const messages = extractMessages(platformId);
    const msgFp = Chatseek.fingerprint([
      conversation.id,
      conversation.title,
      conversation.updatedAt || "",
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
