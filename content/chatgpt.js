(() => {
  const PLATFORM = "chatgpt";
  const state = { lastListFp: "", lastMsgFp: "" };
  let cachedJsonTimes = null;
  let cachedJsonAt = 0;

  function canonicalUrl(id) {
    return `https://chatgpt.com/c/${id}`;
  }

  function conversationIdFromLocation() {
    const path = location.pathname || "";
    if (!/\/c\//.test(path)) return null;
    return Chatseek.uuidFrom(path);
  }

  function titleFromDoc() {
    return Chatseek.stripTitleSuffix(document.title, ["ChatGPT", "OpenAI"]);
  }

  function jsonTimes() {
    const now = Date.now();
    // Re-scan occasionally; page may hydrate more history into scripts.
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
    document.querySelectorAll('a[href*="/c/"]').forEach((a) => {
      const id = Chatseek.uuidFrom(a.getAttribute("href") || a.href);
      if (!id) return;
      anchors.push(a);
    });
    const sectionMap = Chatseek.sectionTimesFor(anchors);
    for (const a of anchors) {
      const id = Chatseek.uuidFrom(a.getAttribute("href") || a.href);
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
    let nodes = [...document.querySelectorAll("[data-message-author-role]")];
    if (!nodes.length) {
      nodes = [...document.querySelectorAll('[data-testid^="conversation-turn"]')];
    }
    if (!nodes.length) {
      nodes = [...document.querySelectorAll("main article")];
    }
    nodes = nodes.filter((node) => {
      if (node.closest("nav, form, textarea")) return false;
      const links = node.querySelectorAll('a[href*="/c/"]');
      if (links.length >= 3) return false;
      return !nodes.some((other) => other !== node && node.contains(other));
    });
    const messages = [];
    nodes.forEach((node) => {
      const roleAttr = node.getAttribute("data-message-author-role") || "";
      if (roleAttr === "system" || roleAttr === "tool") return;
      const heading = Chatseek.textOf(node.querySelector("h5, h6"));
      const role = roleAttr === "assistant" || /^chatgpt/i.test(heading)
        ? "assistant"
        : "user";
      const platformMessageId = node.getAttribute("data-message-id") ||
        node.querySelector("[data-message-id]")?.getAttribute("data-message-id") ||
        Chatseek.hash(role + ":" + Chatseek.textOf(node).slice(0, 180));
      const markdown = node.querySelector(".markdown");
      const pre = node.querySelector(".whitespace-pre-wrap");
      const body = Chatseek.textOf(markdown) || Chatseek.textOf(pre) ||
        Chatseek.cleanClone(node);
      if (!body || Chatseek.isUiNoise(body)) return;
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
    return Chatseek.runCapture(state, {
      platform: PLATFORM,
      sidebar,
      conversation,
      messages,
    });
  }

  Chatseek.observe(capture);
})();
