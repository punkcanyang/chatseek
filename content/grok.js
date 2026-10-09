(() => {
  const PLATFORM = "grok";
  // grok.com history is the normal list, not an archive. No banner to read.
  const state = { lastListFp: "", lastMsgFp: "" };
  const MESSAGE_SELECTORS = [
    "[data-message-author-role]",
    "[data-role]",
    "[data-testid*=message]",
    "[role=article]",
  ];
  let cachedJsonTimes = null;
  let cachedJsonAt = 0;

  function canonicalUrl(id) {
    return `https://grok.com/c/${id}`;
  }

  function idFromHref(href) {
    const uuid = Chatseek.uuidFrom(href);
    if (uuid) return uuid;
    // Some Grok paths are not UUIDs. Keep a stable slug; ignore short UI routes.
    const m = String(href || "").match(
      /\/(?:c|chat)\/([A-Za-z0-9_-]{16,128})(?=[/?#]|$)/,
    );
    return m ? m[1].toLowerCase() : null;
  }

  function conversationIdFromLocation() {
    return idFromHref(location.pathname || "");
  }

  function titleFromDoc() {
    return Chatseek.stripTitleSuffix(document.title, ["Grok", "x\\.ai", "xAI", "X"]);
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
    document
      .querySelectorAll('a[href*="/c/"], a[href*="/chat/"]')
      .forEach((a) => {
        const href = a.getAttribute("href") || a.href || "";
        if (/^https?:/i.test(href) && !/grok\.com|x\.ai/i.test(href)) return;
        if (/\/(?:chat|c)\/new\b/i.test(href)) return;
        const id = idFromHref(href);
        if (!id) return;
        anchors.push(a);
      });
    const sectionMap = Chatseek.sectionTimesFor(anchors);
    for (const slot of Chatseek.sidebarSlots(anchors)) {
      const a = slot.el;
      const href = a.getAttribute("href") || a.href || "";
      const id = idFromHref(href);
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

  function blockedMessageNode(el) {
    if (!el || el.nodeType !== 1) return true;
    if (el.closest("nav, form, textarea, [role='navigation']")) return true;
    const links = el.querySelectorAll?.('a[href*="/c/"], a[href*="/chat/"]');
    return !!(links && links.length >= 3);
  }

  let imageHosts = [];

  async function extractMessages(conversationId, collectImages = true) {
    if (collectImages) imageHosts = [];
    const candidates = [];
    const pushUnique = (el, role) => {
      if (!el || blockedMessageNode(el)) return;
      if (candidates.some((c) => c.el === el)) return;
      candidates.push({ el, role: role || null });
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
          '[data-testid*="message"], [data-testid*="Message"], [role="article"], [class*="message"], [class*="Message"]',
        )
        .forEach((el) => {
          const classList =
            typeof el.className === "string" ? el.className.toLowerCase() : "";
          if (/sidebar|nav|footer|button|input|composer|history/.test(classList)) {
            return;
          }
          // Role may be unknown; alternating roles are applied below.
          pushUnique(el, roleFromNode(el));
        });
    }

    const candidateSet = new Set(candidates.map((item) => item.el));
    const hasCandidateChild = new Set();
    for (const item of candidates) {
      let parent = item.el.parentElement;
      while (parent) {
        if (candidateSet.has(parent)) hasCandidateChild.add(parent);
        parent = parent.parentElement;
      }
    }
    const leaves = candidates.filter((item) => !hasCandidateChild.has(item.el));

    leaves.sort((a, b) => {
      const pos = a.el.compareDocumentPosition(b.el);
      if (pos & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
      if (pos & Node.DOCUMENT_POSITION_PRECEDING) return 1;
      return 0;
    });

    const seen = new Set();
    const messages = [];
    Chatseek._paceAt = Date.now();
    for (let index = 0; index < leaves.length; index += 1) {
      const item = leaves[index];
      if (seen.has(item.el)) continue;
      seen.add(item.el);
      const rendered = Chatseek.safeDomText(item.el, item.role === "user");
      const body = rendered.text;
      await Chatseek.paceDom();
      if (!Chatseek.isSubstantive(body)) continue;
      item.offsets = rendered.offsets;
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
        item.el.querySelector?.("[data-message-id]")?.getAttribute("data-message-id") ||
        item.el.id ||
        Chatseek.hash(role + ":" + body.slice(0, 180));
      const id = `${PLATFORM}:${conversationId}:${platformMessageId}`;
      messages.push({
        id,
        role,
        body,
      });
      if (collectImages) imageHosts.push({ el: item.el, messageId: id, role, body, offsets: item.offsets });
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
        const messages = await extractMessages(platformId, false);
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
