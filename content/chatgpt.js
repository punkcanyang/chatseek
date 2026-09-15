(() => {
  const PLATFORM = "chatgpt";
  let lastListFp = "";
  let lastMsgFp = "";

  function canonicalUrl(id) {
    return `https://chatgpt.com/c/${id}`;
  }

  function conversationIdFromLocation() {
    const path = location.pathname || "";
    if (!/\/c\//.test(path)) return null;
    return Chatseek.uuidFrom(path);
  }

  function titleFromDoc() {
    return (document.title || "")
      .replace(/\s*[|·—-]\s*(ChatGPT|OpenAI).*$/i, "")
      .trim();
  }

  function extractSidebar() {
    const byId = new Map();
    document.querySelectorAll('a[href*="/c/"]').forEach((a) => {
      const id = Chatseek.uuidFrom(a.getAttribute("href") || a.href);
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
    let nodes = [...document.querySelectorAll("[data-message-author-role]")];
    if (!nodes.length) {
      nodes = [...document.querySelectorAll('[data-testid^="conversation-turn"]')];
    }
    const messages = [];
    nodes.forEach((node) => {
      const roleAttr = node.getAttribute("data-message-author-role") || "";
      const heading = Chatseek.textOf(node.querySelector("h5, h6"));
      const role = roleAttr === "assistant" || /^chatgpt/i.test(heading)
        ? "assistant"
        : "user";
      const platformMessageId = node.getAttribute("data-message-id") ||
        Chatseek.hash(role + ":" + Chatseek.textOf(node).slice(0, 180));
      const markdown = node.querySelector(".markdown");
      const pre = node.querySelector(".whitespace-pre-wrap");
      const body = Chatseek.textOf(markdown) || Chatseek.textOf(pre) ||
        Chatseek.cleanClone(node);
      if (!body) return;
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
