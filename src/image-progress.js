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
// content image (http/blob src, not an inline data: pixel) counts as settled.
const IMAGE_SELECTOR = "img, picture, figure, canvas, [data-message-image]";

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
  return PHRASE_SET.has(core);
}

/** Explicit streaming / generation DOM markers, scoped to one turn node. */
export function isProgressNode(node) {
  if (!node || typeof node.querySelector !== "function") return false;
  try {
    if (node.matches?.("[data-is-streaming='true'], [aria-valuenow], [aria-valuetext], [role='progressbar'], progress")) {
      return true;
    }
    return !!node.querySelector(
      "[role='progressbar'], progress, [aria-valuenow], [aria-valuetext]," +
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
      const tag = String(img.tagName || "").toLowerCase();
      if (tag !== "img") return true;
      const src = String(img.getAttribute?.("src") || img.currentSrc || "");
      if (src && !src.startsWith("data:")) return true;
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
  return !/[.。!！?？\n\r]/.test(raw);
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
 * carry { id, role, body }. A run of consecutive progress-only assistant rows
 * folds into the assistant row right after it; if that row is missing, not an
 * assistant, or is itself progress text, the run's own last row is kept. A row
 * with images is a valid keep target (its images stay put), and a progress row
 * that also carries a stale placeholder image is still merged, with its image
 * records moved onto the kept turn by the caller.
 *
 * Returns [{ keep, drop: [ids] }] with drops only when a run has >1 row.
 */
export function planProgressMerges(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const isProg = (row) => !!(row && row.role === "assistant" && isProgressText(row.body));
  const out = [];
  let i = 0;
  while (i < list.length) {
    if (!isProg(list[i])) {
      i += 1;
      continue;
    }
    let j = i;
    while (j < list.length && isProg(list[j])) j += 1;
    const next = list[j];
    const drop = [];
    let keep;
    if (next && next.role === "assistant" && !isProg(next)) {
      keep = next.id;
      for (let k = i; k < j; k += 1) drop.push(list[k].id);
    } else {
      keep = list[j - 1].id;
      for (let k = i; k < j - 1; k += 1) drop.push(list[k].id);
    }
    if (drop.length && keep) out.push({ keep, drop });
    i = j;
  }
  return out;
}
