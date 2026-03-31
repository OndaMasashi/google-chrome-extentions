// NotebookLM Sort by Creation Date - Content Script
// DOM変更への耐性を最優先し、CSSクラス名に依存しない設計

(function () {
  "use strict";

  const CONFIG = {
    DATE_PATTERN: /(\d{4})\/(\d{2})\/(\d{2})/,
    NOTEBOOK_URL_PATTERN: /\/notebook\/[a-f0-9-]+/,
    SORT_BUTTON_TEXTS: ["新しい順", "古い順", "Newest", "Oldest"],
    BUTTON_ID: "nlm-sort-by-creation",
    DEBOUNCE_MS: 500,
    LOG: "[NLM-Sort]",
  };

  // ============================================================
  // DOM探索
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

      // notebook URLリンクを含む祖先があるか確認
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
    return current; // null if el is not a descendant of ancestor
  }

  /**
   * 全祖先スキャンで最適なコンテナを発見する
   *
   * 複数の起点から祖先チェインを辿り、各祖先候補に対して
   * 「何個のユニークな直接子要素が日付要素を含むか」を数える。
   * 最大数の祖先 = 正しいコンテナ（「最近のノートブック」のグリッド）
   */
  function findBestContainer(dateElements) {
    if (dateElements.length < 2) return null;

    // 複数の起点から探索（おすすめ / 最近の両セクションをカバー）
    const startIndices = [
      0,
      Math.floor(dateElements.length / 2),
      dateElements.length - 1,
    ];

    let bestContainer = null;
    let bestCount = 0;

    // 既にチェック済みの祖先を記録
    const checked = new Set();

    for (const idx of startIndices) {
      let el = dateElements[idx].dateElement;

      // この起点の祖先チェインを body まで辿る
      while (el && el !== document.body) {
        el = el.parentElement;
        if (!el || checked.has(el)) continue;
        checked.add(el);

        // この祖先候補に対して、ユニークな直接子要素を数える
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

  // ============================================================
  // ソートボタン
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

  function injectSortButton(anchorElement) {
    if (document.getElementById(CONFIG.BUTTON_ID)) return;

    const btn = document.createElement("button");
    btn.id = CONFIG.BUTTON_ID;
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

    updateButtonLabel(btn);

    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      e.preventDefault();
      btn.dataset.order = btn.dataset.order === "desc" ? "asc" : "desc";
      performSort(btn.dataset.order);
      updateButtonLabel(btn);
    });

    anchorElement.insertAdjacentElement("afterend", btn);
    console.log(CONFIG.LOG, "ソートボタンを注入しました");
  }

  function updateButtonLabel(btn) {
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

  // ============================================================
  // ソートロジック
  // ============================================================

  let isSorting = false;

  function performSort(order = "desc") {
    const dateElements = discoverDateElements();
    const container = findBestContainer(dateElements);

    if (!container) {
      console.warn(CONFIG.LOG, "コンテナが見つかりません");
      return;
    }

    // コンテナ内の日付要素から、ソート単位（直接子要素）を構築
    const unitMap = new Map(); // directChild -> { element, date }
    for (const item of dateElements) {
      const directChild = findDirectChildOf(container, item.dateElement);
      if (!directChild) continue;
      // 同じ直接子要素に複数の日付がある場合、最初のものを使う
      if (unitMap.has(directChild)) continue;
      unitMap.set(directChild, {
        sortableElement: directChild,
        date: item.date,
        dateStr: item.dateStr,
      });
    }

    const units = Array.from(unitMap.values());
    if (units.length === 0) {
      console.warn(CONFIG.LOG, "ソート単位が見つかりません");
      return;
    }

    // ソート
    units.sort((a, b) => {
      const diff = a.date.getTime() - b.date.getTime();
      return order === "desc" ? -diff : diff;
    });

    // DOM並び替え
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
  // 初期化・SPA対応
  // ============================================================

  let debounceTimer = null;

  function tryInjectButton() {
    if (document.getElementById(CONFIG.BUTTON_ID)) return;
    const dateElements = discoverDateElements();
    if (dateElements.length === 0) return;

    const sortBtn = findSortButtonElement();
    if (!sortBtn) return;

    injectSortButton(sortBtn);
  }

  function initialize() {
    const observer = new MutationObserver(() => {
      if (isSorting) return;
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => tryInjectButton(), CONFIG.DEBOUNCE_MS);
    });
    observer.observe(document.body, { childList: true, subtree: true });
    tryInjectButton();

    // SPA遷移検知
    let lastUrl = location.href;
    new MutationObserver(() => {
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        setTimeout(tryInjectButton, 1000);
      }
    }).observe(document, { subtree: true, childList: true });

    console.log(CONFIG.LOG, "初期化完了");
  }

  initialize();
})();
