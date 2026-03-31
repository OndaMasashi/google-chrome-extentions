// NotebookLM Toolkit - Content Script
// DOM変更への耐性を最優先し、CSSクラス名に依存しない設計

(function () {
  "use strict";

  const CONFIG = {
    DATE_PATTERN: /(\d{4})\/(\d{2})\/(\d{2})/,
    NOTEBOOK_URL_PATTERN: /\/notebook\/[a-f0-9-]+/,
    SORT_BUTTON_TEXTS: ["新しい順", "古い順", "Newest", "Oldest"],
    SORT_BUTTON_ID: "nlm-toolkit-sort",
    SEARCH_INPUT_ID: "nlm-toolkit-search",
    DEBOUNCE_MS: 500,
    LOG: "[NLM-Toolkit]",
  };

  // ============================================================
  // DOM探索（ソート・検索共通基盤）
  // ============================================================

  /**
   * YYYY/MM/DD パターン + notebook URLリンクを含む要素を発見
   */
  function discoverDateElements() {
    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode(node) {
          return CONFIG.DATE_PATTERN.test(node.textContent)
            ? NodeFilter.FILTER_ACCEPT
            : NodeFilter.FILTER_REJECT;
        },
      },
    );

    const results = [];
    const seen = new Set();

    while (walker.nextNode()) {
      const textNode = walker.currentNode;
      const dateMatch = textNode.textContent.match(CONFIG.DATE_PATTERN);
      if (!dateMatch) continue;

      let el = textNode.parentElement;
      let hasNotebookLink = false;
      while (el && el !== document.body) {
        if (el.querySelector('a[href*="/notebook/"]')) {
          hasNotebookLink = true;
          break;
        }
        el = el.parentElement;
      }
      if (!hasNotebookLink) continue;

      const dateElement = textNode.parentElement;
      if (seen.has(dateElement)) continue;
      seen.add(dateElement);

      results.push({
        dateElement,
        dateStr: dateMatch[0],
        date: new Date(
          parseInt(dateMatch[1], 10),
          parseInt(dateMatch[2], 10) - 1,
          parseInt(dateMatch[3], 10),
        ),
      });
    }

    return results;
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

    console.log(CONFIG.LOG, `コンテナ検出: ${bestCount}個の直接子要素`);
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

  // ============================================================
  // ツールバー要素の発見
  // ============================================================

  function findSortButtonElement() {
    for (const text of CONFIG.SORT_BUTTON_TEXTS) {
      const result = document.evaluate(
        `//*[contains(text(), '${text}')]`,
        document.body,
        null,
        XPathResult.FIRST_ORDERED_NODE_TYPE,
        null,
      );
      if (result.singleNodeValue) {
        const found = result.singleNodeValue;
        return (
          found.closest("button") ||
          found.closest('[role="button"]') ||
          found.closest('[role="listbox"]') ||
          found
        );
      }
    }
    return null;
  }

  // ============================================================
  // ソート機能
  // ============================================================

  let isSorting = false;

  function injectSortButton(anchorElement) {
    if (document.getElementById(CONFIG.SORT_BUTTON_ID)) return;

    const btn = document.createElement("button");
    btn.id = CONFIG.SORT_BUTTON_ID;
    btn.dataset.order = "desc";

    const computed = window.getComputedStyle(anchorElement);
    btn.style.cssText = `
      padding: ${computed.padding || "6px 16px"};
      border: 1px solid rgba(255,255,255,0.2);
      border-radius: ${computed.borderRadius || "8px"};
      background: transparent;
      color: ${computed.color || "inherit"};
      font-family: ${computed.fontFamily || "inherit"};
      font-size: ${computed.fontSize || "14px"};
      font-weight: ${computed.fontWeight || "normal"};
      cursor: pointer;
      margin-left: 8px;
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

    anchorElement.insertAdjacentElement("afterend", btn);
    console.log(CONFIG.LOG, "ソートボタンを注入しました");
  }

  function updateSortButtonLabel(btn) {
    const dateElements = discoverDateElements();
    const container = findBestContainer(dateElements);
    let count = 0;
    if (container) {
      for (const item of dateElements) {
        if (container.contains(item.dateElement)) count++;
      }
    }
    const arrow = btn.dataset.order === "desc" ? "\u2193" : "\u2191";
    const countStr = count > 0 ? ` (${count}件)` : "";
    btn.textContent = `作成日順 ${arrow}${countStr}`;
  }

  function performSort(order = "desc") {
    const dateElements = discoverDateElements();
    const container = findBestContainer(dateElements);

    if (!container) {
      console.warn(CONFIG.LOG, "コンテナが見つかりません");
      return;
    }

    const units = buildSortUnits(dateElements, container);
    if (units.length === 0) return;

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

  function injectSearchInput(anchorElement) {
    if (document.getElementById(CONFIG.SEARCH_INPUT_ID)) return;

    const input = document.createElement("input");
    input.id = CONFIG.SEARCH_INPUT_ID;
    input.type = "text";
    input.placeholder = "ノートブックを検索...";

    const computed = window.getComputedStyle(anchorElement);
    input.style.cssText = `
      padding: ${computed.padding || "6px 16px"};
      border: 1px solid rgba(255,255,255,0.2);
      border-radius: ${computed.borderRadius || "8px"};
      background: transparent;
      color: ${computed.color || "inherit"};
      font-family: ${computed.fontFamily || "inherit"};
      font-size: ${computed.fontSize || "14px"};
      margin-left: 8px;
      width: 200px;
      outline: none;
      position: relative;
      z-index: 1;
    `;

    // フォーカス時のスタイル
    input.addEventListener("focus", () => {
      input.style.borderColor = "rgba(138,180,248,0.8)";
    });
    input.addEventListener("blur", () => {
      input.style.borderColor = "rgba(255,255,255,0.2)";
    });

    // イベントが裏のUIに伝播しないようにする
    input.addEventListener("click", (e) => e.stopPropagation());
    input.addEventListener("keydown", (e) => e.stopPropagation());

    // リアルタイムフィルタ
    let filterTimer = null;
    input.addEventListener("input", () => {
      clearTimeout(filterTimer);
      filterTimer = setTimeout(() => performFilter(input.value), 150);
    });

    // ソートボタンの後に挿入（あれば）、なければアンカーの後
    const sortBtn = document.getElementById(CONFIG.SORT_BUTTON_ID);
    const insertAfter = sortBtn || anchorElement;
    insertAfter.insertAdjacentElement("afterend", input);

    console.log(CONFIG.LOG, "検索フィールドを注入しました");
  }

  function performFilter(query) {
    const dateElements = discoverDateElements();
    const container = findBestContainer(dateElements);
    if (!container) return;

    const units = buildSortUnits(dateElements, container);
    const normalizedQuery = query.trim().toLowerCase();

    let visibleCount = 0;

    for (const unit of units) {
      const el = unit.sortableElement;

      // 元の display 値を初回のみ保存
      if (!originalDisplay.has(el)) {
        originalDisplay.set(el, el.style.display);
      }

      if (normalizedQuery === "") {
        // フィルタ解除
        el.style.display = originalDisplay.get(el) || "";
        visibleCount++;
      } else {
        // カード内のテキストで部分一致検索
        const cardText = el.textContent.toLowerCase();
        if (cardText.includes(normalizedQuery)) {
          el.style.display = originalDisplay.get(el) || "";
          visibleCount++;
        } else {
          el.style.display = "none";
        }
      }
    }

    console.log(
      CONFIG.LOG,
      `フィルタ "${query}": ${visibleCount}/${units.length}件表示`,
    );
  }

  // ============================================================
  // 初期化・SPA対応
  // ============================================================

  let debounceTimer = null;

  function tryInjectUI() {
    const dateElements = discoverDateElements();
    if (dateElements.length === 0) return;

    const sortBtn = findSortButtonElement();
    if (!sortBtn) return;

    // ソートボタン注入
    injectSortButton(sortBtn);
    // 検索フィールド注入
    injectSearchInput(sortBtn);
  }

  function initialize() {
    const observer = new MutationObserver(() => {
      if (isSorting) return;
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => tryInjectUI(), CONFIG.DEBOUNCE_MS);
    });
    observer.observe(document.body, { childList: true, subtree: true });
    tryInjectUI();

    // SPA遷移検知
    let lastUrl = location.href;
    new MutationObserver(() => {
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        setTimeout(tryInjectUI, 1000);
      }
    }).observe(document, { subtree: true, childList: true });

    console.log(CONFIG.LOG, "初期化完了");
  }

  initialize();
})();
