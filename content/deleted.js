/* Read-only page evidence. Text/structure below are conservative fixture
 * assumptions, not selectors verified against signed-in production accounts. */
(() => {
  const TRANSCRIPT = "[data-message-author-role], [data-testid='user-message'], [data-testid='human-message'], [data-testid='assistant-message'], [data-testid='ai-message'], [role='article'], [data-turn], [data-message-id], [data-testid*='conversation-turn'], user-query, model-response, .font-user-message, .font-claude-message, .message-bubble, .markdown, .prose, .query-text, .model-response-text, [data-role='user'], [data-role='assistant']";
  const EXCLUDE = `${TRANSCRIPT}, nav, aside, [role='navigation'], [role='menu'], form, textarea, [contenteditable='true'], pre, code, blockquote, [hidden], [aria-hidden='true']`;
  const exact = [
    "conversation not found", "chat not found", "this conversation was deleted", "this chat was deleted",
    "this conversation has been deleted", "this chat has been deleted", "this conversation does not exist",
    "this chat does not exist", "you do not have access to this conversation", "you do not have permission to view this conversation",
    "找不到這段對話", "找不到此對話", "找不到對話", "此對話已刪除", "這段對話已刪除", "無權限存取此對話",
    "找不到此会话", "找不到对话", "此对话已删除", "此会话已删除", "无权访问此对话",
    "この会話が見つかりません", "このチャットは削除されました", "この会話にアクセスする権限がありません",
    "대화를 찾을 수 없습니다", "이 대화는 삭제되었습니다", "이 대화에 접근할 권한이 없습니다",
    "conversación no encontrada", "esta conversación se ha eliminado", "no tienes acceso a esta conversación",
    "conversation introuvable", "cette conversation a été supprimée", "vous n’avez pas accès à cette conversation",
    "unterhaltung nicht gefunden", "diese unterhaltung wurde gelöscht", "du hast keinen zugriff auf diese unterhaltung",
    "conversa não encontrada", "esta conversa foi excluída", "você não tem acesso a esta conversa",
  ];
  const normalized = (text) => String(text || "").toLowerCase().normalize("NFKC").replace(/\s+/g, " ").trim().replace(/[.!。！]+$/, "");
  const phrases = new Set(exact.map(normalized));
  const loginWords = new Set([
    "sign in", "signin", "log in", "login", "sign in to continue", "log in to continue", "continue with google", "continue with apple",
    "登入", "登錄", "登入以繼續", "繼續使用 google", "登录", "登陆", "登录以继续", "使用 google 继续",
    "ログイン", "サインイン", "ログインして続行", "google で続行", "로그인", "로그인하여 계속", "google로 계속하기",
    "iniciar sesión", "inicia sesión", "acceder", "continuar con google", "se connecter", "connexion", "connectez-vous", "continuer avec google",
    "anmelden", "einloggen", "mit google fortfahren", "entrar", "iniciar sessão", "fazer login", "continuar com o google",
  ].map(normalized));
  const observations = new WeakMap();
  function loginLabel(text) {
    const value = normalized(text);
    if (value.length > 160) return false;
    return loginWords.has(value)
      || /^(?:sign[- ]?in|log[- ]?in|continue with (?:google|apple|microsoft)|iniciar sesión|inicia sesión|acceder|se connecter|connexion|connectez-vous|anmelden|einloggen|entrar|iniciar sessão|fazer login)(?:$|\s|[:：])/i.test(value)
      || /^(?:登入|登錄|登录|登陆|ログイン|サインイン|로그인)/.test(value)
      || /^(?:使用|繼續使用|继续使用).*(?:google|apple|microsoft).*(?:登入|登录|继续|繼續)/i.test(value);
  }
  const GENERIC = new Set(["page not found", "not found", "404", "403", "access denied", "permission denied",
    "找不到網頁", "页面不存在", "ページが見つかりません", "페이지를 찾을 수 없습니다", "página no encontrada", "page introuvable", "seite nicht gefunden", "página não encontrada"]);
  const blockers = /sign in|log in|login|verify you are human|captcha|cloudflare|checking your browser|too many requests|rate limit|try again later|network error|connection error|something went wrong|offline|loading|try again|登入|登录|驗證|验证|網路錯誤|网络错误|稍後再試|稍后再试|載入中|加载中|離線|离线|ログイン|読み込み|認証|ネットワーク|로그인|로딩|인증|네트워크|iniciar sesión|inicia sesión|cargando|error de red|connexion|chargement|réessayez|anmelden|wird geladen|netzwerk|entrar|carregando|erro de rede|\b(?:429|500|502|503|504)\b/i;
  function outside(node) { return !node.closest?.(EXCLUDE); }
  function visible(node) {
    if (!outside(node)) return false;
    return displayed(node);
  }
  function displayed(node) {
    const win = node.ownerDocument.defaultView;
    if (win?.getComputedStyle) {
      for (let el = node; el; el = el.parentElement) {
        const style = win.getComputedStyle(el);
        if (style.display === "none" || style.visibility === "hidden") return false;
      }
    }
    return true;
  }
  Chatseek.readDeletedPage = (doc = document, loc = location) => {
    const main = doc.querySelector("main, [role='main']");
    const transcripts = [...doc.querySelectorAll(TRANSCRIPT)].filter((node) => !node.closest("nav, aside, [role='navigation']") && (node.textContent || "").trim());
    let observation = observations.get(doc);
    if (!observation) observations.set(doc, observation = { href: loc.href, nodes: [], residual: new WeakSet() });
    if (observation.href !== loc.href) {
      for (const node of observation.nodes) observation.residual.add(node);
      observation.href = loc.href;
    }
    observation.nodes = transcripts;
    const currentId = (loc.pathname || "").match(/\/(?:c|chat|app)\/([A-Za-z0-9_-]+)/)?.[1]
      || (/\/gem\//.test(loc.pathname || "") ? loc.pathname.split("/").pop() : "");
    // Hidden/old SPA turns are uncertain evidence, never proof of either
    // presence or absence. Hold deletion and recovery until they disappear.
    const ambiguous = transcripts.some((node) => !visibleTranscript(node) || observation.residual.has(node)
      || (node.closest("[data-conversation-id]") && node.closest("[data-conversation-id]").getAttribute("data-conversation-id").toLowerCase() !== String(currentId).toLowerCase()));
    const body = !ambiguous && transcripts.some(visibleTranscript);
    const selector = "h1, h2, [role='alert'], [role='status'], [data-testid*='not-found'], [data-testid*='deleted'], [data-testid*='error'], [data-error-code]" + (body ? "" : ", p, div");
    const nodes = [...doc.querySelectorAll(selector)].slice(0, 2000).filter(visible);
    const signals = Chatseek.syncPageSignals(doc, loc);
    const blocked = ambiguous || doc.readyState !== "complete" || doc.defaultView?.navigator.onLine === false
      || /\/(?:login|signin|auth|challenge)(?:\/|$)/i.test(loc.pathname || "")
      || signals.hasPassword || signals.hasLoginForm || signals.hasChallengeNode || signals.hasRateBanner
      || !!doc.querySelector("[aria-busy='true'], [role='progressbar'], [data-testid='loading']")
      || nodes.some((node) => blockers.test(normalized(node.textContent)));
    let hits = 0;
    if (!body) for (const node of nodes) {
      const value = normalized(node.textContent);
      if (!value || value.length > 240) continue;
      const structured = node.getAttribute("data-error-code") === "404"
        || /(?:conversation|chat)-(?:not-found|deleted|access-denied)/.test(node.getAttribute("data-testid") || "");
      const genericHeading = node.tagName === "H1" && !["403", "access denied", "permission denied"].includes(value);
      if (phrases.has(value) || (GENERIC.has(value) && (structured || genericHeading) && main?.contains(node))) hits++;
    }
    // A redirect requires a healthy application shell; an empty/error document
    // and a standalone sign-in button are insufficient.
    const login = [...doc.querySelectorAll("a, button, h1, h2, [role='button'], [role='heading']")].some((node) => !node.closest(`${TRANSCRIPT}, pre, code, blockquote, [hidden], [aria-hidden='true']`) && displayed(node)
      && (loginLabel(node.textContent) || loginLabel(node.getAttribute("aria-label"))
        || /\/(?:login|log-in|signin|sign-in|auth)(?:\/|[?#]|$)/i.test(node.getAttribute("href") || "")));
    const shell = !!main && [...main.querySelectorAll("textarea, [contenteditable='true'], [role='textbox']")].some((node) => displayed(node));
    return { hits: blocked || login ? 0 : Math.min(40, hits), error: hits > 0,
      blocked: !!blocked || login, body, homeReady: !blocked && !login && !body && shell };
  };
  function visibleTranscript(node) {
    return !node.closest("nav, aside, [hidden], [aria-hidden='true'], [aria-busy='true']")
      && !node.querySelector("[role='progressbar']") && displayed(node);
  }
  let timer = 0;
  let redirectContext = null;
  Chatseek.checkDeletedPage = async (platform) => {
    try { if (typeof window !== "undefined" && window.top !== window) return { hits: 0 }; } catch { return { hits: 0 }; }
    const href = location.href;
    const page = Chatseek.readDeletedPage();
    // Resolve the current conversation through the background's shared URL
    // parser, including Gemini account prefixes. No sidebar disappearance.
    const context = await Chatseek.send({ type: "DELETED_VISIT_CONTEXT", platform });
    if (location.href !== href) return { hits: 0 };
    const navigation = document.defaultView?.performance.getEntriesByType?.("navigation")?.[0];
    const redirected = !!context?.id && !context.direct && Number(navigation?.redirectCount) > 0
      && navigation.name === href && page.homeReady;
    redirectContext = context;
    if (context?.direct && page.body) await Chatseek.send({ type: "DELETED_VISIT_CANCEL" });
    const hits = page.blocked ? 0 : page.hits || (redirected ? 1 : 0);
    Chatseek._deletedHits = hits;
    const suppressCapture = page.error; // Even uncertain errors must not become new chats.
    if (context?.id) {
      await Chatseek.send({ type: "DELETED_OBSERVATION", platform, id: context.id,
        hits, blocked: page.blocked, redirected });
      if (location.href !== href) return { hits: 0, suppressCapture: true };
    }
    clearTimeout(timer);
    if (hits) timer = setTimeout(() => Chatseek.requestRescan?.(), 1200);
    return { hits, suppressCapture };
  };
  Chatseek.restoreDeletedPage = async (conversation, messages, identity) => {
    if (!conversation || !messages?.length || !identity?.check() || conversation.archived === true) return;
    const page = Chatseek.readDeletedPage();
    if (!page.body || page.blocked || page.hits) return;
    if (conversation.platform === "chatgpt") {
      const archive = Chatseek.readArchiveSignals(document, location, "chatgpt");
      if (archive.banner || archive.archiveRoots.some((root) => Chatseek._archiveListIds(root).includes(conversation.platformId || conversation.id.split(":")[1]))) return;
    }
    if (!identity.check()) return;
    await Chatseek.send({ type: "RESTORE_SITE_DELETED", platform: conversation.platform, id: conversation.id,
      messageCount: messages.length });
  };
  if (typeof document !== "undefined") for (const event of ["click", "keydown"]) {
    document.addEventListener(event, (ev) => {
      if (!ev.isTrusted || !redirectContext) return;
      redirectContext = null;
      Chatseek.send({ type: "DELETED_VISIT_CANCEL" });
    }, true);
  }
})();
