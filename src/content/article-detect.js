// Finds the element that bounds the actual article content on the page,
// so progress/word-count are computed against the article, not header/nav/footer chrome.
(function () {
  window.Breakpoint = window.Breakpoint || {};

  const MIN_TEXT_LENGTH = 200;

  // Hostname -> CSS selector, for sites where <article>/<main> is missing or too small.
  const SITE_OVERRIDES = {
    "substack.com": ".available-content, .post-content",
  };

  function textLength(el) {
    return (el.innerText || "").trim().length;
  }

  function trySemanticTag() {
    const candidates = [
      document.querySelector("article"),
      document.querySelector("main article"),
      document.querySelector("main"),
    ];
    for (const el of candidates) {
      if (el && textLength(el) >= MIN_TEXT_LENGTH) return el;
    }
    return null;
  }

  function trySiteOverride() {
    const host = location.hostname.replace(/^www\./, "");
    for (const domain in SITE_OVERRIDES) {
      if (host === domain || host.endsWith("." + domain)) {
        const el = document.querySelector(SITE_OVERRIDES[domain]);
        if (el && textLength(el) >= MIN_TEXT_LENGTH) return el;
      }
    }
    return null;
  }

  const NEGATIVE_HINTS = /nav|sidebar|footer|header|comment|related|promo|advert|banner|menu/i;
  const POSITIVE_HINTS = /article|content|post|story|main|body/i;

  function linkDensity(el) {
    const textLen = textLength(el);
    if (textLen === 0) return 1;
    let linkLen = 0;
    el.querySelectorAll("a").forEach((a) => {
      linkLen += (a.innerText || "").length;
    });
    return linkLen / textLen;
  }

  function scoreElement(el) {
    let score = textLength(el) / 100;
    score *= 1 - Math.min(linkDensity(el), 0.9);
    const signature = (el.className || "") + " " + (el.id || "");
    if (POSITIVE_HINTS.test(signature)) score *= 1.25;
    if (NEGATIVE_HINTS.test(signature)) score *= 0.25;
    return score;
  }

  function tryReadabilityScore() {
    const paragraphs = Array.from(document.querySelectorAll("p")).filter(
      (p) => (p.innerText || "").trim().length > 40
    );
    if (paragraphs.length === 0) return null;

    const candidateScores = new Map();
    paragraphs.forEach((p) => {
      let node = p.parentElement;
      let depth = 0;
      while (node && depth < 3) {
        if (!candidateScores.has(node)) candidateScores.set(node, 0);
        node = node.parentElement;
        depth++;
      }
    });

    let best = null;
    let bestScore = 0;
    candidateScores.forEach((_, el) => {
      const s = scoreElement(el);
      if (s > bestScore) {
        bestScore = s;
        best = el;
      }
    });

    return best && textLength(best) >= MIN_TEXT_LENGTH ? best : null;
  }

  function findArticleElement() {
    return (
      trySemanticTag() || trySiteOverride() || tryReadabilityScore() || document.body
    );
  }

  function getWordCount(el) {
    const text = (el.innerText || "").trim();
    if (!text) return 0;
    return text.split(/\s+/).length;
  }

  // Section headings within the article, for the user-assigned breakpoints
  // panel — every heading is listed, unfiltered; the panel is opt-in (the
  // user opens it and picks), unlike the earlier auto-suggested breakpoints
  // that tried to filter/dedupe headings for an always-visible display.
  function findHeadings(el) {
    return Array.from(el.querySelectorAll("h2, h3"))
      .map((heading) => ({ element: heading, label: (heading.innerText || "").trim() }))
      .filter((h) => h.label.length > 0);
  }

  window.Breakpoint.detect = { findArticleElement, getWordCount, findHeadings };
})();
