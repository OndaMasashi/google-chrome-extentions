// Gemini Notebook (旧 NotebookLM) Toolkit - Content Script
// DOM変更への耐性を最優先し、CSSクラス名に依存しない設計

(function () {
  "use strict";

  const CONFIG = {
    // ノートブックカードを識別するためのリンク／属性
    NOTEBOOK_LINK_SELECTOR:
      'a[href*="/notebook/"], a[href*="/notebooks/"], [data-notebook-id]',
    // 並び替えUIのラベル候補（この横にツールバーを差し込む）
    SORT_LABELS: [
      "新しい順",
      "古い順",
      "最近使用したもの",
      "更新日順",
      "名前順",
      "Newest",
      "Oldest",
      "Recently viewed",
      "Most recent",
      "Title",
    ],
    SORT_BUTTON_ID: "nlm-toolkit-sort",
    SEARCH_INPUT_ID: "nlm-toolkit-search",
    PANEL_ID: "nlm-toolkit-panel",
    DEBOUNCE_MS: 500,
    // アンカーが見つからない回数がこれを超えたら浮動パネルに切り替える
    ANCHOR_RETRY_LIMIT: 6,
    // 注入できるまでの定期リトライ（DOMの変化が止まっても取りこぼさないため）
    RETRY_INTERVAL_MS: 800,
    RETRY_MAX: 40,
    LOG: "[NLM-Toolkit]",
  };

  // ============================================================
  // 日付パース（ロケール差・表記ゆれを吸収）
  // ============================================================

  const MONTH_NAMES = {
    jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
    jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
  };

  function makeDate(y, m, d) {
    y = Number(y);
    m = Number(m);
    d = Number(d);
    if (!y || m < 1 || m > 12 || d < 1 || d > 31) return null;
    const date = new Date(y, m - 1, d);
    return isNaN(date.getTime()) ? null : date;
  }

  function monthFromName(name) {
    return MONTH_NAMES[name.slice(0, 3).toLowerCase()];
  }

  const DATE_MATCHERS = [
    // 2026/08/31, 2026-08-31
    { re: /(\d{4})[/-](\d{1,2})[/-](\d{1,2})/, build: (m) => makeDate(m[1], m[2], m[3]) },
    // 2026年8月31日
    { re: /(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/, build: (m) => makeDate(m[1], m[2], m[3]) },
    // Aug 31, 2026 / August 31, 2026
    { re: /([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})/, build: (m) => makeDate(m[3], monthFromName(m[1]), m[2]) },
    // 31 Aug 2026
    { re: /(\d{1,2})\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})/, build: (m) => makeDate(m[3], monthFromName(m[2]), m[1]) },
  ];

  function parseDate(text) {
    for (const matcher of DATE_MATCHERS) {
      const m = text.match(matcher.re);
      if (!m) continue;
      const date = matcher.build(m);
      if (date) return { date, dateStr: m[0] };
    }
    return null;
  }

  // ============================================================
  // DOM探索（ソート・検索共通基盤）
  // ============================================================

  /**
   * 日付テキスト + ノートブックリンクを含む要素を発見。
   * ページ内にノートブックリンクが1つも無い場合（SPAがaタグを使わない構成）は
   * リンク条件を外して日付テキストのみで探索する。
   */
  function discoverDateElements() {
    const requireLink =
      document.querySelector(CONFIG.NOTEBOOK_LINK_SELECTOR) !== null;

    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode(node) {
          // 全ての対応フォーマットは4桁の西暦を含む
          return /\d{4}/.test(node.textContent)
            ? NodeFilter.FILTER_ACCEPT
            : NodeFilter.FILTER_REJECT;
        },
      },
    );

    const results = [];
    const seen = new Set();

    while (walker.nextNode()) {
      const textNode = walker.currentNode;
      const parsed = parseDate(textNode.textContent);
      if (!parsed) continue;

      const dateElement = textNode.parentElement;
      if (!dateElement || seen.has(dateElement)) continue;

      if (requireLink && !hasNotebookLinkAncestor(dateElement)) continue;
      if (isToolkitElement(dateElement)) continue;

      seen.add(dateElement);
      results.push({
        dateElement,
        dateStr: parsed.dateStr,
        date: parsed.date,
      });
    }

    return results;
  }

  function hasNotebookLinkAncestor(el) {
    let current = el;
    while (current && current !== document.body) {
      if (current.querySelector(CONFIG.NOTEBOOK_LINK_SELECTOR)) return true;
      current = current.parentElement;
    }
    return false;
  }

  /** 自前で注入したUIを探索対象から除外する */
  function isToolkitElement(el) {
    return el.closest(`#${CONFIG.PANEL_ID}`) !== null;
  }

  /**
   * ancestor の直接の子要素のうち、el を含むものを返す
   */
  function findDirectChildOf(ancestor, el) {
    let current = el;
    while (current && current.parentElement !== ancestor) {
      current = current.parentElement;
    }
    return current;
  }

  /**
   * 全祖先スキャンで最適なコンテナを発見する
   */
  function findBestContainer(dateElements) {
    if (dateElements.length < 2) return null;

    const startIndices = [
      0,
      Math.floor(dateElements.length / 2),
      dateElements.length - 1,
    ];

    let bestContainer = null;
    let bestCount = 0;
    const checked = new Set();

    for (const idx of startIndices) {
      let el = dateElements[idx].dateElement;

      while (el && el !== document.body) {
        el = el.parentElement;
        if (!el || checked.has(el)) continue;
        checked.add(el);

        const childSet = new Set();
        for (const item of dateElements) {
          const child = findDirectChildOf(el, item.dateElement);
          if (child) childSet.add(child);
        }

        if (childSet.size > bestCount) {
          bestCount = childSet.size;
          bestContainer = el;
        }
      }
    }

    return bestContainer;
  }

  /**
   * コンテナ内のソート可能な単位（直接子要素 + 日付）を構築
   */
  function buildSortUnits(dateElements, container) {
    const unitMap = new Map();
    for (const item of dateElements) {
      const directChild = findDirectChildOf(container, item.dateElement);
      if (!directChild) continue;
      if (unitMap.has(directChild)) continue;
      unitMap.set(directChild, {
        sortableElement: directChild,
        date: item.date,
        dateStr: item.dateStr,
      });
    }
    return Array.from(unitMap.values());
  }

  /** 探索結果をまとめて取得する */
  function collect() {
    const dateElements = discoverDateElements();
    const container = findBestContainer(dateElements);
    if (!container) return { dateElements, container: null, units: [] };
    return {
      dateElements,
      container,
      units: buildSortUnits(dateElements, container),
    };
  }

  // ============================================================
  // ツールバー要素の発見
  // ============================================================

  /**
   * 並び替えUIらしきボタンを探す。完全一致を優先し、無ければ部分一致。
   */
  function findAnchorElement() {
    const candidates = document.querySelectorAll(
      'button, [role="button"], [role="combobox"], [role="listbox"]',
    );
    let loose = null;

    for (const el of candidates) {
      if (isToolkitElement(el)) continue;
      const text = (el.textContent || "").trim();
      // ラベルとして不自然に長いものは容器要素なので除外
      if (!text || text.length > 24) continue;

      for (const label of CONFIG.SORT_LABELS) {
        if (text === label) return el;
        if (!loose && text.includes(label)) loose = el;
      }
    }
    return loose;
  }

  // ============================================================
  // UI部品の生成
  // ============================================================

  const FLOATING_STYLE = {
    padding: "6px 12px",
    borderRadius: "8px",
    color: "#e8eaed",
    fontFamily: "system-ui, sans-serif",
    fontSize: "13px",
    fontWeight: "500",
  };

  /** アンカー要素の見た目を引き継ぐ（浮動時は既定値） */
  function resolveStyle(anchorElement) {
    if (!anchorElement) return FLOATING_STYLE;
    const c = window.getComputedStyle(anchorElement);
    return {
      padding: c.padding || FLOATING_STYLE.padding,
      borderRadius: c.borderRadius || FLOATING_STYLE.borderRadius,
      color: c.color || "inherit",
      fontFamily: c.fontFamily || "inherit",
      fontSize: c.fontSize || FLOATING_STYLE.fontSize,
      fontWeight: c.fontWeight || FLOATING_STYLE.fontWeight,
    };
  }

  function createSortButton(style) {
    const btn = document.createElement("button");
    btn.id = CONFIG.SORT_BUTTON_ID;
    btn.dataset.order = "desc";
    btn.style.cssText = `
      padding: ${style.padding};
      border: 1px solid rgba(138,180,248,0.5);
      border-radius: ${style.borderRadius};
      background: transparent;
      color: ${style.color};
      font-family: ${style.fontFamily};
      font-size: ${style.fontSize};
      font-weight: ${style.fontWeight};
      cursor: pointer;
      white-space: nowrap;
      position: relative;
      z-index: 1;
    `;

    updateSortButtonLabel(btn);

    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      e.preventDefault();
      btn.dataset.order = btn.dataset.order === "desc" ? "asc" : "desc";
      performSort(btn.dataset.order);
      updateSortButtonLabel(btn);
    });

    return btn;
  }

  function createSearchInput(style) {
    const input = document.createElement("input");
    input.id = CONFIG.SEARCH_INPUT_ID;
    input.type = "text";
    input.placeholder = "ノートブックを検索...";
    input.style.cssText = `
      padding: ${style.padding};
      border: 1px solid rgba(255,255,255,0.25);
      border-radius: ${style.borderRadius};
      background: transparent;
      color: ${style.color};
      font-family: ${style.fontFamily};
      font-size: ${style.fontSize};
      width: 200px;
      outline: none;
      position: relative;
      z-index: 1;
    `;

    input.addEventListener("focus", () => {
      input.style.borderColor = "rgba(138,180,248,0.8)";
    });
    input.addEventListener("blur", () => {
      input.style.borderColor = "rgba(255,255,255,0.25)";
    });

    // イベントが裏のUIに伝播しないようにする
    input.addEventListener("click", (e) => e.stopPropagation());
    input.addEventListener("keydown", (e) => e.stopPropagation());

    let filterTimer = null;
    input.addEventListener("input", () => {
      clearTimeout(filterTimer);
      filterTimer = setTimeout(() => performFilter(input.value), 150);
    });

    return input;
  }

  // ============================================================
  // UI注入（インライン / 浮動パネル）
  // ============================================================

  function isInjected() {
    return document.getElementById(CONFIG.SORT_BUTTON_ID) !== null;
  }

  function injectInline(anchorElement) {
    const style = resolveStyle(anchorElement);
    const btn = createSortButton(style);
    btn.style.marginLeft = "8px";
    const input = createSearchInput(style);
    input.style.marginLeft = "8px";

    anchorElement.insertAdjacentElement("afterend", btn);
    btn.insertAdjacentElement("afterend", input);
    console.log(CONFIG.LOG, "ツールバーを注入しました（インライン）");
  }

  function injectFloating() {
    const panel = document.createElement("div");
    panel.id = CONFIG.PANEL_ID;
    panel.style.cssText = `
      position: fixed;
      right: 16px;
      bottom: 16px;
      z-index: 2147483000;
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 10px;
      border-radius: 12px;
      background: rgba(32,33,36,0.94);
      box-shadow: 0 2px 12px rgba(0,0,0,0.35);
    `;

    const style = FLOATING_STYLE;
    panel.appendChild(createSortButton(style));
    panel.appendChild(createSearchInput(style));
    document.body.appendChild(panel);
    console.log(CONFIG.LOG, "ツールバーを注入しました（浮動パネル）");
  }

  // ============================================================
  // ソート機能
  // ============================================================

  let isSorting = false;

  function updateSortButtonLabel(btn) {
    const { units } = collect();
    const arrow = btn.dataset.order === "desc" ? "↓" : "↑";
    const countStr = units.length > 0 ? ` (${units.length}件)` : "";
    btn.textContent = `作成日順 ${arrow}${countStr}`;
  }

  function performSort(order = "desc") {
    const { container, units } = collect();

    if (!container || units.length === 0) {
      console.warn(CONFIG.LOG, "ソート対象のコンテナが見つかりません");
      return;
    }

    units.sort((a, b) => {
      const diff = a.date.getTime() - b.date.getTime();
      return order === "desc" ? -diff : diff;
    });

    isSorting = true;
    for (const unit of units) {
      container.appendChild(unit.sortableElement);
    }
    isSorting = false;

    console.log(
      CONFIG.LOG,
      `${units.length}件を作成日${order === "desc" ? "降順" : "昇順"}でソートしました`,
    );
  }

  // ============================================================
  // 検索（タイトルフィルタ）機能
  // ============================================================

  /** 元の display 値を保存するための WeakMap */
  const originalDisplay = new WeakMap();

  function performFilter(query) {
    const { units } = collect();
    if (units.length === 0) return;

    const normalizedQuery = query.trim().toLowerCase();
    let visibleCount = 0;

    for (const unit of units) {
      const el = unit.sortableElement;

      // 元の display 値を初回のみ保存
      if (!originalDisplay.has(el)) {
        originalDisplay.set(el, el.style.display);
      }

      const matched =
        normalizedQuery === "" ||
        el.textContent.toLowerCase().includes(normalizedQuery);

      if (matched) {
        el.style.display = originalDisplay.get(el) || "";
        visibleCount++;
      } else {
        el.style.display = "none";
      }
    }

    console.log(
      CONFIG.LOG,
      `フィルタ "${query}": ${visibleCount}/${units.length}件表示`,
    );
  }

  // ============================================================
  // 診断ログ（UIを出せなかったときに原因を吐く）
  // ============================================================

  let failureCount = 0;
  let diagnosed = false;

  function logDiagnostics(dateElements) {
    const links = document.querySelectorAll(CONFIG.NOTEBOOK_LINK_SELECTOR);
    const buttonTexts = [];
    for (const el of document.querySelectorAll('button, [role="button"]')) {
      const t = (el.textContent || "").trim();
      if (t && t.length <= 24 && !buttonTexts.includes(t)) buttonTexts.push(t);
      if (buttonTexts.length >= 20) break;
    }

    console.warn(
      CONFIG.LOG,
      "UIを注入できませんでした。以下を開発者に共有してください:",
      {
        url: location.href,
        日付要素の数: dateElements.length,
        日付サンプル: dateElements.slice(0, 3).map((d) => d.dateStr),
        ノートブックリンク数: links.length,
        ボタンラベル一覧: buttonTexts,
      },
    );
  }

  // ============================================================
  // 初期化・SPA対応
  // ============================================================

  let debounceTimer = null;

  function tryInjectUI() {
    const dateElements = discoverDateElements();

    if (isInjected()) {
      // 一覧が遅延ロードされるので件数表示だけ追従させる
      updateSortButtonLabel(document.getElementById(CONFIG.SORT_BUTTON_ID));
      return;
    }

    if (dateElements.length === 0) return;

    const anchor = findAnchorElement();
    if (anchor) {
      injectInline(anchor);
      failureCount = 0;
      diagnosed = false;
      return;
    }

    // 並び替えUIが見つからない場合は一定回数待ってから浮動パネルに切り替える
    failureCount++;
    if (failureCount >= CONFIG.ANCHOR_RETRY_LIMIT) {
      injectFloating();
      failureCount = 0;
      diagnosed = false;
    } else if (!diagnosed && failureCount === 3) {
      diagnosed = true;
      logDiagnostics(dateElements);
    }
  }

  /**
   * 注入できるまで定期的にリトライする。
   * 一覧の描画が終わってDOMの変化が止まると MutationObserver は発火しないため、
   * フォールバック（浮動パネル）への到達をタイマーで保証する。
   */
  let retryTimer = null;
  let retryCount = 0;

  function startRetryLoop() {
    stopRetryLoop();
    retryCount = 0;
    retryTimer = setInterval(() => {
      if (isInjected() || ++retryCount > CONFIG.RETRY_MAX) {
        stopRetryLoop();
        return;
      }
      tryInjectUI();
    }, CONFIG.RETRY_INTERVAL_MS);
  }

  function stopRetryLoop() {
    if (retryTimer) clearInterval(retryTimer);
    retryTimer = null;
  }

  function resetInjection() {
    document.getElementById(CONFIG.PANEL_ID)?.remove();
    document.getElementById(CONFIG.SORT_BUTTON_ID)?.remove();
    document.getElementById(CONFIG.SEARCH_INPUT_ID)?.remove();
    failureCount = 0;
    diagnosed = false;
  }

  function initialize() {
    const observer = new MutationObserver(() => {
      if (isSorting) return;
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(tryInjectUI, CONFIG.DEBOUNCE_MS);
    });
    observer.observe(document.body, { childList: true, subtree: true });

    tryInjectUI();
    startRetryLoop();

    // SPA遷移検知
    let lastUrl = location.href;
    new MutationObserver(() => {
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        resetInjection();
        setTimeout(() => {
          tryInjectUI();
          startRetryLoop();
        }, 1000);
      }
    }).observe(document, { subtree: true, childList: true });

    console.log(CONFIG.LOG, "初期化完了", location.host);
  }

  initialize();
})();
