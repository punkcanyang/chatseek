/**
 * ChatGPT image-generation progress text.
 *
 * While ChatGPT paints an image it rewrites a single assistant turn with short
 * status strings plus a percentage ("Creating image 25%", "Sketching 38%").
 * Each rewrite used to become a brand-new stored message, so the reader showed
 * a dozen near-identical blocks. This module classifies those bodies so the
 * capture path can drop them until the turn settles.
 *
 * Conservative by design: a body is progress-only when, after removing a
 * percentage token, it is exactly one of the known status phrases. Ordinary
 * prose that happens to contain "%" is never matched. The DOM marker path
 * (progressbar / streaming) is a second, narrower signal.
 *
 * Pure functions only: no DOM, no I/O. content/shared.js carries the same
 * logic for the isolated content-script world; scripts/verify.mjs keeps the
 * two copies in sync.
 */

export const PROGRESS_PHRASES = [
  // zh_TW
  "正在建立圖像", "正在建立影像", "正在勾勒草圖", "正在生成初稿", "正在打磨細節",
  "正在生成圖片", "正在繪製", "正在生成圖像", "正在修飾細節",
  "正在創建圖像", "正在創建影像", "正在創建圖片", "正在描繪",
  // zh_CN
  "正在创建图像", "正在创建影像", "正在勾勒草图", "正在生成初稿", "正在打磨细节",
  "正在生成图片", "正在绘制", "正在生成图像", "正在修饰细节",
  "正在创建图片", "正在描绘",
  // en
  "creating image", "creating your image", "creating an image",
  "sketching", "adding details", "generating image", "generating an image",
  "refining details", "drawing", "painting", "generating draft",
  "starting image generation", "creating the image",
  // ja
  "画像を作成しています", "画像を生成しています", "スケッチを作成しています",
  "詳細を追加しています", "下書きを生成しています", "画像を描いています",
  "画像を作成中", "画像を生成中", "スケッチ中", "詳細を追加中",
  // ko
  "이미지 생성 중", "이미지를 생성하는 중", "이미지 만들기 중", "이미지를 만드는 중",
  "스케치 중", "스케치하는 중", "세부 사항 추가 중", "세부 정보 추가 중",
  "초안 생성 중", "초안을 생성하는 중", "이미지 그리는 중",
  // es
  "creando imagen", "generando imagen", "dibujando", "agregando detalles",
  "añadiendo detalles", "creando la imagen", "generando la imagen",
  "creando borrador", "perfeccionando detalles",
  // fr
  "création de l'image", "génération de l'image", "esquisse en cours",
  "ajout des détails", "ajout de détails", "création d'image",
  "génération d'image", "affinage des détails", "dessin en cours",
  // de
  "bild wird erstellt", "bild wird generiert", "skizze wird erstellt",
  "details werden hinzugefügt", "bild erstellen", "bild generieren",
  "entwurf wird erstellt", "details werden verfeinert",
  // pt_BR
  "criando imagem", "gerando imagem", "esboçando", "adicionando detalhes",
  "criando a imagem", "gerando a imagem", "criando rascunho",
  "refinando detalhes",
];

const PHRASE_SET = new Set(PROGRESS_PHRASES);

// A progress turn may keep a small decorative bitmap (spinner). Only a real
// content image (not a small spinner or inline data: pixel) counts as settled.
const IMAGE_SELECTOR = "img";

/** Fold a status string to its comparable core: no %, no strays, lowercase. */
export function progressCore(raw) {
  let text = String(raw ?? "").replace(/[\u3000\u00a0]/g, " ");
  text = text.replace(/\s+/g, " ").trim();
  // Leading bullets / spinners / dashes.
  text = text.replace(/^[\s\-–—_•·*※…‥.。]+/, "");
  // Percentage token, with or without a space, half or full width.
  text = text.replace(/\d{1,3}\s*[%％]/g, " ");
  // A trailing percentage number that lost its sign, and trailing punctuation.
  text = text.replace(/\s+\d{1,3}\s*$/, "");
  text = text.replace(/[\s\-–—_•·*※…‥.。!！?？~～、,，:：;；]+$/g, "");
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

/** True when the whole assistant body is one known progress phrase. */
export function isProgressText(body) {
  const core = progressCore(body);
  if (!core) return false;
  // A single word such as Drawing can be a legitimate answer.
  if (/^(drawing|painting|sketching|dibujando|esboçando)$/.test(core) &&
      !/\d{1,3}\s*[%％]/.test(String(body))) return false;
  return PHRASE_SET.has(core);
}

/** Explicit streaming / generation DOM markers, scoped to one turn node. */
export function isProgressNode(node) {
  if (!node || typeof node.querySelector !== "function") return false;
  try {
    if (node.matches?.("[data-is-streaming='true'], [role='progressbar'], progress")) {
      return true;
    }
    return !!node.querySelector(
      "[role='progressbar'], progress," +
      "[data-is-streaming='true'], [data-testid*='progress' i], [data-testid*='streaming' i]",
    );
  } catch {
    return false;
  }
}

function hasContentImage(node) {
  if (!node || typeof node.querySelectorAll !== "function") return false;
  try {
    for (const img of node.querySelectorAll(IMAGE_SELECTOR)) {
      const src = String(img.getAttribute?.("src") || img.currentSrc || "");
      const width = Number(img.getAttribute?.("width") || img.naturalWidth || 0);
      const height = Number(img.getAttribute?.("height") || img.naturalHeight || 0);
      if ((width && width <= 32) || (height && height <= 32)) continue;
      if (src && (!src.startsWith("data:") || (width > 32 && height > 32))) return true;
    }
  } catch {
    return false;
  }
  return false;
}

/** A short, unpunctuated status line under a streaming/progress marker. */
function isShortStatusLine(body) {
  const core = progressCore(body);
  if (!core) return false;
  if (core.length > 48) return false;
  const raw = String(body ?? "").replace(/\s+/g, " ").trim();
  return !/[.。!！?？\n\r]/.test(raw) &&
    /^(正在(?:準備|准备|生成|建立|繪製|绘制|創建|创建|思考)|準備中|准备中|thinking|loading|generating|creating|preparing|drawing|painting|sketching)(?:\b|[\u4e00-\u9fff])/i.test(core);
}

/**
 * The one entry the capture path calls. body is the resolved turn text, node
 * the turn element (optional; markers and settled images live there).
 */
export function isProgressMessage(body, node) {
  if (node && hasContentImage(node)) return false;
  if (isProgressText(body)) return true;
  if (node && isProgressNode(node) && isShortStatusLine(body)) return true;
  return false;
}

/**
 * Group already-stored rows into merges. rows must be in stored order and
 * carry { id, role, body, conversationId, captureIndex }, optionally a
 * `turnId` when the capture knows a stable per-turn identity. Only adjacent
 * rows with the same conversation, same role and the same batch-local
 * captureIndex can form a merge.
 *
 * captureIndex alone is not proof of position: it is the index inside the
 * capture window, so two windows can both report slot 1 for different turns.
 * A merge therefore also needs extra position evidence: a shared non-empty
 * persisted turnId. A preceding user row does not bind later captures to the
 * same turn, and must never substitute for that evidence. Without it the
 * rows are left alone: keeping a duplicate is safe, deleting a different
 * turn is not.
 *
 * A run of consecutive progress-only assistant rows folds into the assistant
 * row right after it; if that row is missing, not an assistant, or is itself
 * progress text, the run's own last row is kept. A row with images is a valid
 * keep target (its images stay put), and a progress row that also carries a
 * stale placeholder image is still merged, with its image records moved onto
 * the kept turn by the caller.
 *
 * Returns [{ keep, drop: [ids] }] with drops only when a run has >1 row.
 */
export function planProgressMerges(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const isProg = (row) => !!(row && row.role === "assistant" && isProgressText(row.body));
  const sameConv = (a, b) => !!a && !!b && typeof a.conversationId === "string" &&
    a.conversationId === b.conversationId;
  const sameTurn = (a, b) => !!a && !!b && typeof a.turnId === "string" && a.turnId !== "" &&
    a.turnId === b.turnId;
  const sameSlot = (a, b) => sameConv(a, b) &&
    Number.isInteger(a.captureIndex) && a.captureIndex >= 0 && a.captureIndex === b.captureIndex;
  const out = [];
  let i = 0;
  while (i < list.length) {
    if (!isProg(list[i])) {
      i += 1;
      continue;
    }
    let j = i + 1;
    while (j < list.length && isProg(list[j]) && sameSlot(list[i], list[j]) &&
        sameTurn(list[i], list[j])) j += 1;
    const next = list[j];
    const drop = [];
    let keep = null;
    if (next && next.role === "assistant" && !isProg(next) &&
        sameSlot(list[i], next) && sameTurn(list[i], next)) {
      keep = next.id;
      for (let k = i; k < j; k += 1) drop.push(list[k].id);
    } else if (j - i > 1) {
      keep = list[j - 1].id;
      for (let k = i; k < j - 1; k += 1) drop.push(list[k].id);
    }
    if (drop.length && keep) out.push({ keep, drop });
    i = j;
  }
  return out;
}
