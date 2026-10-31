// SPDX-License-Identifier: GPL-3.0-or-later
// providers/arena.js - the Arena (arena.ai) provider for UqBOAT.
// Supports BOTH Arena Direct Mode (/text/direct, /c/<uuid>) AND Arena Agent
// Mode (/agent, /agent/<uuid>).
// eslint-disable-next-line no-unused-vars
const ZSProvider = (() => {
  "use strict";
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let diag = () => {}; // injected by core via init()
  let _attachedImages = null;

  const S = {
    list: "ol.flex-col-reverse",
    box: ".prose",                 // markdown body (both user + assistant turns)
    carousel: '[role="region"][aria-roledescription="carousel"]',
    slide: '[aria-roledescription="slide"]',
    codeWrap: "div.not-prose",     // fenced-code wrapper inside .prose
    sendAria: /send( message)?|envoyer|submit/i,
    stopAria: /stop( generation| generating| response| agent)?|arr[êe]ter/i,
    errorSurfaces:
      '[role="alert"],[class*="toast"],[class*="error"],[class*="alert"],[data-sonner-toast]',
  };

  // Roblox Studio API keywords used to detect when an Arena Agent Mode reply
  // emitted a bare ```lua / ```luau block intended for Studio without ###LUA###.
  const ROBLOX_LUA_RE =
    /\b(?:Instance\.new|game\s*:\s*GetService|workspace\b|ServerScriptService|ReplicatedStorage|StarterGui|StarterPack|StarterPlayer|ServerStorage|Lighting|TweenService|RunService|UserInputService|Players|CFrame\.|Vector3\.|Color3\.|UDim2\.|BrickColor\.|Enum\.|task\.(?:wait|spawn|delay)|:WaitForChild\s*\(|:FindFirstChild\s*\(|:GetChildren\s*\(|:GetDescendants\s*\(|:Destroy\s*\(|:Clone\s*\()/;

  const RE = {
    contextLimit: new RegExp(
      [
        "conversation.{0,20}(too long|trop long)",
        "context.{0,20}(limit|exceeded|d\\u00e9pass\\u00e9)",
        "please.{0,30}(start|cr\\u00e9er).{0,20}(new|nouveau).{0,20}(chat|conversation)",
        "(token|context).{0,10}limit",
        "message.{0,20}too.{0,10}long",
        "maximum.{0,20}context",
        "this conversation has reached",
      ].join("|"),
      "i"
    ),
    tooLong: /conversation .{0,20}(too long|getting too long|trop longue)/i,
    busy: /something went wrong|une erreur s.est produite|try again later|réessayer plus tard|rate limit|too many requests/i,
  };

  const timings = {
    GEN_IDLE_MS: 1500,
    REASON_IDLE_MS: 12000,
    WARMUP_MS: 45000,
    REASON_NOREPLY_MS: 90000,
    STABLE_MS: 9000,
    RESPONSE_TIMEOUT_MS: 300000,
  };

  // ── Composer / Editor discovery (placed early so turn discovery can scope away from it) ──
  const getEditor = () => {
    for (const e of document.querySelectorAll("form textarea")) {
      if (!e.closest("#zs-root") && e.offsetParent !== null) {
        return e;
      }
    }
    for (const e of document.querySelectorAll('textarea[name="message"], textarea')) {
      if (e.closest("#zs-root")) continue;
      if (e.getAttribute("aria-hidden") === "true" || /recaptcha/i.test(e.name || e.id || e.className || "")) continue;
      if (e.offsetParent !== null) {
        return e;
      }
    }
    for (const e of document.querySelectorAll(
      '.ProseMirror[contenteditable="true"], .ProseMirror, [contenteditable="true"][role="textbox"], [role="textbox"][contenteditable], div[contenteditable="true"]'
    )) {
      if (e.closest("#zs-root") || e.closest("ol")) continue;
      if (e.offsetParent !== null) {
        return e;
      }
    }
    for (const e of document.querySelectorAll(
      'form textarea, .ProseMirror, [contenteditable="true"][role="textbox"], div[contenteditable="true"]'
    )) {
      if (!e.closest("#zs-root") && !e.closest("ol")) {
        return e;
      }
    }
    return null;
  };

  const isContentEditable = (e) =>
    !!e &&
    e.tagName !== "TEXTAREA" &&
    e.tagName !== "INPUT" &&
    (!!e.isContentEditable ||
      e.classList.contains("ProseMirror") ||
      e.getAttribute("role") === "textbox" ||
      e.hasAttribute("contenteditable"));

  const composerFrame = () => {
    const ed = getEditor();
    if (!ed) return null;
    const form = ed.closest("form");
    if (form) {
      const fr = typeof form.getBoundingClientRect === "function" ? form.getBoundingClientRect() : null;
      if (!fr || fr.height <= 320) return form;
    }
    let n = ed;
    let best = ed.parentElement || ed;
    for (let i = 0; i < 10 && n && n !== document.body; i++) {
      if (typeof n.getBoundingClientRect === "function") {
        const nr = n.getBoundingClientRect();
        if (nr.height > 320) break;
      }
      if (n.classList && [...n.classList].some((c) => c.startsWith("rounded"))) best = n;
      n = n.parentElement;
    }
    return best;
  };

  function barAnchor() {
    const ed = getEditor();
    if (!ed) return null;
    let n = ed;
    for (let i = 0; i < 10 && n && n !== document.body; i++) {
      if (typeof n.getBoundingClientRect === "function") {
        const nr = n.getBoundingClientRect();
        if (nr.height > 320) break;
      }
      if (n.classList && [...n.classList].some((c) => c.startsWith("rounded"))) return n;
      n = n.parentElement;
    }
    return composerFrame();
  }

  // ── Turn classification ───────────────────────────────────────────────────
  const isCarouselItem = (c) => !!c && !!c.querySelector && !!c.querySelector(S.carousel);

  function listEl() {
    return document.querySelector(S.list) || null;
  }

  function isRealSysPromptText(raw) {
    if (!raw) return false;
    if (raw.includes("ADDITIONAL RULES FOR THIS SITE")) return true;
    if (raw.includes(ZS.SYS_MARKER) && raw.length >= 260) return true;
    return false;
  }

  function hasRightAlignSignal(el) {
    if (!el || el.nodeType !== 1) return false;
    if (el.dataset && el.dataset.zsRole === "user") return true;
    const cls = el.classList;
    if (
      cls &&
      (cls.contains("justify-end") ||
        cls.contains("items-end") ||
        cls.contains("self-end") ||
        cls.contains("ml-auto"))
    ) {
      return true;
    }
    try {
      const st = getComputedStyle(el);
      if (
        st.justifyContent === "flex-end" ||
        st.alignItems === "flex-end" ||
        st.alignSelf === "flex-end" ||
        st.marginLeft === "auto"
      ) {
        return true;
      }
    } catch {}
    if (el.parentElement && typeof el.getBoundingClientRect === "function") {
      const pr = el.parentElement.getBoundingClientRect();
      const r = el.getBoundingClientRect();
      if (pr.width > 200 && r.width > 0 && r.left > pr.left + 40 && r.right >= pr.right - 60) {
        return true;
      }
    }
    return false;
  }

  function isInChatViewport(el, ed, comp, compRect) {
    if (!el || el.nodeType !== 1) return false;
    if (
      el.closest &&
      el.closest(
        "#zs-root, nav, aside, header, [data-sidebar], [role='navigation'], [role='dialog']"
      )
    ) {
      return false;
    }
    if (ed && (el === ed || el.contains(ed))) return false;
    if (comp && (el === comp || comp.contains(el) || el.contains(comp))) return false;

    const isTagged =
      (el.dataset && (el.dataset.zs || el.dataset.zsRole)) ||
      (el.classList && el.classList.contains("zs-hidden"));
    const measureEl =
      (el.classList && el.classList.contains("zs-hidden") && el.querySelector && el.querySelector(".zs-chip")) ||
      (el.closest && el.closest(".zs-hidden")) ||
      el;

    if (typeof measureEl.getBoundingClientRect !== "function") return true;
    const r = measureEl.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) {
      return !!isTagged;
    }
    // Exclude top header bar (y <= 56) and left sidebar (x <= 250)
    if (r.bottom <= 56 || r.right <= 250) return false;
    if (compRect && compRect.width > 100 && compRect.height <= 320 && compRect.top > 120) {
      if (r.top >= compRect.top - 2) return false;
      if (r.right < compRect.left - 160 || r.left > compRect.right + 160) return false;
    }
    return true;
  }

  function getTurnChildren(container, ed, comp, compRect) {
    if (!container || !container.children) return [];
    return [...container.children].filter((c) => {
      if (!c || c.nodeType !== 1) return false;
      if (c.classList && c.classList.contains("zs-chip")) return false;
      const tag = (c.tagName || "").toUpperCase();
      if (
        tag === "SCRIPT" ||
        tag === "STYLE" ||
        tag === "HEADER" ||
        tag === "NAV" ||
        tag === "ASIDE" ||
        tag === "BUTTON"
      ) {
        return false;
      }
      if (ed && (c === ed || c.contains(ed))) return false;
      if (comp && (c === comp || c.contains(comp) || comp.contains(c))) return false;
      if (c.classList && c.classList.contains("zs-hidden")) return true;
      if (c.dataset && (c.dataset.zs || c.dataset.zsRole)) return true;
      if (!isInChatViewport(c, ed, comp, compRect)) return false;
      const r =
        typeof c.getBoundingClientRect === "function"
          ? c.getBoundingClientRect()
          : { height: 20, width: 200 };
      if (r.height < 12 || r.width < 80) return false;
      return (c.textContent || "").trim().length > 0;
    });
  }

  function normalizeTurnItem(c) {
    if (!c || !c.querySelector) return c;
    const innerSys = c.querySelector(
      "[data-zs='sys'], [data-zs='result'], [data-zs-role='user']"
    );
    if (innerSys && innerSys !== c) {
      if (innerSys.dataset.zs && !c.dataset.zs) c.dataset.zs = innerSys.dataset.zs;
      if (innerSys.dataset.zphase && !c.dataset.zphase) c.dataset.zphase = innerSys.dataset.zphase;
      if (innerSys.dataset.zsig && !c.dataset.zsig) c.dataset.zsig = innerSys.dataset.zsig;
      if (innerSys.dataset.zsRole) c.dataset.zsRole = innerSys.dataset.zsRole;
      if (innerSys.classList.contains("zs-hidden")) {
        c.classList.add("zs-hidden");
        innerSys.classList.remove("zs-hidden");
      }
      const chip = innerSys.querySelector(":scope > .zs-chip");
      if (chip && chip.parentElement !== c) {
        c.insertBefore(chip, c.firstChild);
      }
    }
    return c;
  }

  // Arena Agent Mode (/agent, /agent/<uuid>) renders its conversation inside a
  // flex-col <div> stack (`listStack`) inside the scrollable viewport above the
  // composer. We discover turns BOTTOM-UP from the turn content leaves in the
  // central chat viewport and find their Lowest Common Ancestor (`listStack`).
  // By tree topology, `listStack` is the ONLY ancestor that contains all turn
  // leaves and has >= 2 direct children containing turn leaves, so we NEVER stop
  // above `listStack` at `scrollArea` or `mainCol` and NEVER touch the sidebar
  // or top header bar.
  function findAgentTurns() {
    const ed = getEditor();
    const comp = barAnchor() || composerFrame() || ed;
    const compRect =
      comp && typeof comp.getBoundingClientRect === "function"
        ? comp.getBoundingClientRect()
        : null;

    const userBubbles = [];
    const assistantNodes = [];

    // 1. Already-decorated UqBOAT turn elements
    for (const el of document.querySelectorAll("[data-zs], [data-zs-role='user'], .zs-hidden")) {
      if (!isInChatViewport(el, ed, comp, compRect)) continue;
      if (el.classList && el.classList.contains("zs-chip")) continue;
      userBubbles.push(el);
    }

    // 2. Deepest DOM elements matching the UqBOAT system prompt or tool feedback
    for (const el of document.querySelectorAll("div, p, span, article, section")) {
      if (!isInChatViewport(el, ed, comp, compRect)) continue;
      if (el.closest && el.closest("a, button, pre, code, .zs-chip")) continue;
      const txt = (el.textContent || "").trim();
      if (!isRealSysPromptText(txt) && !ZSParse.isInjectedFeedback(txt)) continue;

      let childHasIt = false;
      for (const ch of el.children || []) {
        const ct = (ch.textContent || "").trim();
        if (isRealSysPromptText(ct) || ZSParse.isInjectedFeedback(ct)) {
          childHasIt = true;
          break;
        }
      }
      if (childHasIt) continue;

      // Promote up to the user bubble / right-aligned turn wrapper, stopping
      // before any scrollable pane, multi-turn container, or >720px non-right-aligned column
      let bubble = el;
      let p = el.parentElement;
      while (p && p !== document.body && isInChatViewport(p, ed, comp, compRect)) {
        try {
          const st = getComputedStyle(p);
          if (st.overflowY === "auto" || st.overflowY === "scroll") break;
        } catch {}
        if (!el.querySelector("pre") && p.querySelector && p.querySelector("pre")) break;
        const pr =
          typeof p.getBoundingClientRect === "function"
            ? p.getBoundingClientRect()
            : { width: 500 };
        if (hasRightAlignSignal(p) || (pr.width > 0 && pr.width <= 720)) {
          bubble = p;
          p = p.parentElement;
        } else {
          break;
        }
      }
      if (!userBubbles.includes(bubble)) userBubbles.push(bubble);
    }

    // 2b. Plain user bubbles (right-aligned user messages like "ev yap")
    for (const el of document.querySelectorAll(
      '[data-message-author-role="user"], [data-testid*="user" i], [class*="user-message" i], [class*="userMessage" i], .justify-end, .items-end, .self-end, .ml-auto'
    )) {
      if (!isInChatViewport(el, ed, comp, compRect)) continue;
      if (el.closest && el.closest("a, button, pre, code, .zs-chip")) continue;
      const txt = (el.textContent || "").trim();
      if (!txt || txt.length > 4000) continue;
      if (ZSParse.hasCommandShape(txt) || ZSParse.hasToolSignature(txt)) continue;
      if (el.querySelector && el.querySelector("pre, .zs-chip:not(.sys):not(.result)")) continue;
      if (!userBubbles.includes(el)) userBubbles.push(el);
    }

    // Keep outermost user bubble per user turn (without merging distinct turns)
    const cleanUserBubbles = userBubbles.filter(
      (a) => !userBubbles.some((b) => b !== a && b.contains(a) && !b.querySelector("pre"))
    );

    // 3. Assistant content leaves (.prose, div.not-prose, pre) not inside a user bubble
    for (const el of document.querySelectorAll(`${S.box}, ${S.codeWrap}, pre`)) {
      if (!isInChatViewport(el, ed, comp, compRect)) continue;
      if (el.closest && el.closest(".zs-chip")) continue;
      if (cleanUserBubbles.some((ub) => ub === el || ub.contains(el))) continue;
      assistantNodes.push(el);
    }

    // Deduplicate assistant nodes: keep innermost leaves so each assistant turn has clean leaf anchors
    const cleanAssistantLeaves = assistantNodes.filter(
      (a) => !assistantNodes.some((b) => b !== a && a.contains(b))
    );

    const roots = [...cleanUserBubbles, ...cleanAssistantLeaves];
    if (!roots.length) return [];

    // Walk UP from roots[0] to find the Lowest Common Ancestor (`listStack`)
    // that contains all `roots` and distributes them across >= 2 direct children.
    if (roots.length >= 2) {
      let cand = roots[0].parentElement;
      while (cand && cand !== document.body) {
        if (ed && cand.contains(ed)) break;
        if (comp && cand.contains(comp)) break;
        if (roots.every((r) => cand.contains(r))) {
          const kidsWithRoots = [...cand.children].filter((c) =>
            roots.some((r) => c === r || c.contains(r))
          );
          if (kidsWithRoots.length >= 2) {
            const turnKids = getTurnChildren(cand, ed, comp, compRect);
            for (const kr of kidsWithRoots) {
              if (!turnKids.includes(kr)) turnKids.push(kr);
            }
            turnKids.sort((a, b) => {
              const ra = typeof a.getBoundingClientRect === "function" ? a.getBoundingClientRect().top : 0;
              const rb = typeof b.getBoundingClientRect === "function" ? b.getBoundingClientRect().top : 0;
              return ra - rb;
            });
            return turnKids.map(normalizeTurnItem);
          }
        }
        cand = cand.parentElement;
      }
    }

    // Single turn leaf found so far (e.g., Turn 1 just sent, or Turn 2 is plain text without .prose/pre).
    // Check up to 2 ancestor levels above `single` to see if `listStack` already has >= 2 vertically stacked turns.
    const single = roots[0];
    let p = single.parentElement;
    for (let d = 0; d < 2 && p && p !== document.body; d++, p = p.parentElement) {
      if (ed && p.contains(ed)) break;
      if (comp && p.contains(comp)) break;
      if (!isInChatViewport(p, ed, comp, compRect)) break;
      try {
        const st = getComputedStyle(p);
        if (st.overflowY === "auto" || st.overflowY === "scroll") break;
      } catch {}
      if (hasRightAlignSignal(p)) continue;
      const kids = getTurnChildren(p, ed, comp, compRect);
      if (kids.length >= 2) {
        const r0 = typeof kids[0].getBoundingClientRect === "function" ? kids[0].getBoundingClientRect() : null;
        const r1 = typeof kids[1].getBoundingClientRect === "function" ? kids[1].getBoundingClientRect() : null;
        if (!r0 || !r1 || r1.top >= r0.bottom - 8) {
          return kids.map(normalizeTurnItem);
        }
      }
    }

    return [normalizeTurnItem(single)];
  }

  function domTurns() {
    const ol = listEl();
    if (ol) {
      return [...ol.children].filter(
        (c) =>
          (c.classList.contains("mx-auto") ||
            isCarouselItem(c) ||
            c.classList.contains("zs-hidden") ||
            !!(c.dataset && c.dataset.zs)) &&
          (!!c.querySelector(S.box) ||
            c.classList.contains("zs-hidden") ||
            !!(c.dataset && c.dataset.zs) ||
            !!c.querySelector(".zs-chip") ||
            !!c.querySelector(S.codeWrap))
      );
    }
    return findAgentTurns();
  }

  // Return all relevant .prose containers inside `item` (skipping collapsed
  // reasoning/thinking <details> blocks when there is a main reply .prose).
  function proseNodesOf(item) {
    if (!item) return [];
    const scope = item.querySelector(S.slide) || item;
    const allProse = [...scope.querySelectorAll(S.box)].filter((p) => !p.closest(".zs-chip"));
    if (allProse.length <= 1) return allProse;
    const nonThinking = allProse.filter(
      (p) => !p.closest('details, [data-testid*="think" i], [class*="thinking" i], [class*="reasoning" i], [class*="thought" i], [data-state="closed"]')
    );
    return nonThinking.length ? nonThinking : allProse;
  }

  function proseOf(item) {
    if (!item) return null;
    const nodes = proseNodesOf(item);
    if (nodes.length === 1) return nodes[0];
    if (nodes.length > 1) {
      if (isRealSysPromptText(nodes[0].textContent || "")) return nodes[0];
      for (let i = nodes.length - 1; i >= 0; i--) {
        const t = nodes[i].textContent || "";
        if (ZSParse.hasCommandShape(t) || ZSParse.hasToolSignature(t)) return nodes[i];
      }
      return nodes[nodes.length - 1];
    }
    const slide = item.querySelector(S.slide);
    const root = slide || item;
    return root.querySelector(S.codeWrap) || root.querySelector("pre") || null;
  }

  function isUserItem(item) {
    if (!item) return false;
    const raw = item.textContent || "";
    // Safety guard: if an outer container ever held BOTH the system prompt AND an
    // assistant <pre> with a command, never classify it as a user turn so the
    // assistant's command is still read and executed!
    if (item.querySelector) {
      for (const pre of item.querySelectorAll("pre")) {
        if (pre.closest && pre.closest(".zs-chip")) continue;
        const pt = (pre.textContent || "").trim();
        if (pt.startsWith("{") && pt.includes('"command"') && isRealSysPromptText(raw)) {
          return false;
        }
      }
    }
    if (
      item.dataset &&
      (item.dataset.zs === "sys" ||
        item.dataset.zs === "result" ||
        item.dataset.zs === "resend" ||
        item.dataset.zsig ||
        item.dataset.zsRole === "user")
    ) {
      return true;
    }
    if (item.querySelector && item.querySelector(".zs-chip.sys, .zs-chip.result")) return true;
    if (isRealSysPromptText(raw) || ZSParse.isInjectedFeedback(raw)) {
      item.dataset.zsRole = "user";
      return true;
    }
    // Assistant-only signatures: command blocks, tool chips, or loop-owned turns
    // are NEVER user items.
    if (item.dataset && (item.dataset.zsRole === "assistant" || item.dataset.zloop)) {
      return false;
    }
    if (item.querySelector && item.querySelector(".zs-chip:not(.sys):not(.result)")) {
      return false;
    }
    const cleanTxt = textWithout(item).trim();
    if (ZSParse.hasCommandShape(cleanTxt) || ZSParse.hasToolSignature(cleanTxt)) {
      return false;
    }
    if (hasRightAlignSignal(item)) {
      item.dataset.zsRole = "user";
      return true;
    }
    // On Arena Agent Mode, `item` is often a full-width turn row (`w-full`) and
    // `firstChild` is the centered `mx-auto max-w-3xl` container, while the
    // actual right-aligned user bubble (`flex justify-end` / `ml-auto` / right
    // bounding box) is at depth 1..5 inside `item`. Walk wrappers that hold the
    // full turn text so toolbar buttons inside assistant turns are never matched.
    if (cleanTxt.length > 0 && item.querySelectorAll) {
      const itemRect =
        typeof item.getBoundingClientRect === "function"
          ? item.getBoundingClientRect()
          : { left: 0, right: 0, width: 0 };
      const checkNode = (el, depth) => {
        if (!el || el.nodeType !== 1 || depth > 5) return false;
        const tag = (el.tagName || "").toUpperCase();
        if (tag === "BUTTON" || tag === "A" || tag === "SVG" || tag === "PRE") return false;
        if (el.classList && el.classList.contains("zs-chip")) return false;
        const roleAttr = (el.getAttribute && (el.getAttribute("data-message-author-role") || el.getAttribute("data-testid") || el.className || "")) || "";
        if (/\buser(-message|Message|_message)?\b/i.test(String(roleAttr))) {
          return true;
        }
        const elTxt = textWithout(el).trim();
        if (elTxt === cleanTxt) {
          if (hasRightAlignSignal(el)) return true;
          if (itemRect.width > 240 && typeof el.getBoundingClientRect === "function") {
            const r = el.getBoundingClientRect();
            if (r.width > 0 && r.width < itemRect.width * 0.88) {
              const leftGap = r.left - itemRect.left;
              const rightGap = itemRect.right - r.right;
              if (leftGap > rightGap + 32 && leftGap > 40) return true;
            }
          }
        }
        for (const ch of el.children || []) {
          if (checkNode(ch, depth + 1)) return true;
        }
        return false;
      };
      if (checkNode(item, 0)) {
        item.dataset.zsRole = "user";
        return true;
      }
    }
    return false;
  }
  const isAssistantItem = (item) => !!item && !isUserItem(item);

  // ── Chip anchor ───────────────────────────────────────────────────────────
  function chipAnchor(item) {
    if (!item) return item;
    const prose = proseOf(item);
    return (prose && prose.parentElement) || item;
  }

  // ── A/B "battle" resolution & Continue affordance ─────────────────────────
  const CONT_A_RE = /^\s*(continuer avec a|continue with a|a ile devam et|devam et)\s*$/i;
  const CONTINUE_BTN_RE = /^\s*(continue|continue working|keep working|keep generating|continue generating|resume|resume working|devam et|devam|çalışmaya devam et|calismaya devam et|çalışmaya devam|çalışmayı sürdür|continuer)\s*[.!…]*\s*$/i;
  const THROTTLE_RE =
    /too many requests|trop de requ[êe]tes|rate.?limit|failed to (skip|continue|vote)|impossible/i;
  const BATTLE_COOLDOWN_MS = 6000;
  let _battleAt = 0, _battleClicks = 0, _throttleLogged = false;
  function actionThrottled() {
    for (const el of document.querySelectorAll(S.errorSurfaces)) {
      if (el.offsetParent === null) continue;
      if (THROTTLE_RE.test(el.innerText || "")) return true;
    }
    return false;
  }
  function resolveBattle() {
    if (Date.now() - _battleAt < BATTLE_COOLDOWN_MS) return false;
    if (actionThrottled()) {
      if (!_throttleLogged) { _throttleLogged = true; diag("arena.battle_throttled", { clicks: _battleClicks }); }
      return false;
    }
    _throttleLogged = false;
    for (const b of document.querySelectorAll("button")) {
      if (b.offsetParent === null) continue;
      if (b.disabled || b.getAttribute("aria-disabled") === "true") continue;
      if (CONT_A_RE.test(b.textContent || "") || CONT_A_RE.test(ariaOf(b))) {
        _battleAt = Date.now();
        _battleClicks++;
        diag("arena.battle_pick_a", { n: _battleClicks, label: (b.textContent || "").trim().slice(0, 24) });
        try { b.click(); } catch {}
        return true;
      }
    }
    return false;
  }

  // Walk the tree skipping the core's chip (and any extra excluded subtree).
  function textWithout(root, excludeSel) {
    if (!root) return "";
    const skip = ".zs-chip" + (excludeSel ? ", " + excludeSel : "");
    let t = "";
    const walk = (n) => {
      if (n.nodeType === 3) { t += n.nodeValue; return; }
      if (n.nodeType !== 1) return;
      if (n.matches && n.matches(skip)) return;
      const isBlock = n.tagName === "PRE" || n.tagName === "DIV" || n.tagName === "P";
      if (isBlock && t && !t.endsWith("\n")) t += "\n";
      for (const c of n.childNodes) walk(c);
      if (isBlock && t && !t.endsWith("\n")) t += "\n";
    };
    walk(root);
    return t;
  }

  // Extract bare ```lua / ```luau code blocks from an Arena assistant turn
  // when the Agent Mode model wrote Roblox Studio Luau code in a standard
  // code block without ###LUA### ... ###END_LUA### markers.
  function extractFallbackRobloxLua(item, baseText) {
    // Native agent tool results and GitHub source snippets must never become
    // executable Studio commands merely because they contain Roblox Lua.
    if (/^\/agent(?:\b|\/)/i.test(location.pathname)) return "";
    if (!item || !isAssistantItem(item)) return "";
    if (!baseText || ZSParse.hasToolSignature(baseText) || ZSParse.hasCommandShape(baseText)) {
      return "";
    }
    const scope = item.querySelector(S.slide) || item;
    const codeEls = [...scope.querySelectorAll("div.not-prose pre code, pre code")];
    const snippets = [];
    for (const codeEl of codeEls) {
      if (codeEl.closest(".zs-chip")) continue;
      const wrap = codeEl.closest(S.codeWrap) || codeEl.closest("pre");
      const wrapText = (wrap ? wrap.textContent : "") || "";
      const code = (codeEl.textContent || "").trim();
      if (!code || code.length < 12) continue;
      const cls = (codeEl.className || "") + " " + ((wrap && wrap.className) || "");
      const header = wrapText.slice(0, Math.max(0, wrapText.indexOf(code))).toLowerCase();
      const isLuaBlock =
        /\b(?:lua|luau)\b/i.test(cls) ||
        /\b(?:lua|luau)\b/i.test(header) ||
        ROBLOX_LUA_RE.test(code);
      if (isLuaBlock && ROBLOX_LUA_RE.test(code)) {
        snippets.push(code);
      }
    }
    if (!snippets.length) return "";
    return "\n###LUA###\n" + snippets.join("\n\n") + "\n###END_LUA###";
  }

  function cleanAgentAssistantText(raw) {
    if (!raw) return "";
    return raw
      .replace(
        /^\s*(?:Unsupported connector|Thought for \d+\s*(?:seconds?|s|ms)|Thinking\.{0,3}|\d+s\s*\|\s*(?:just now|\d+\s+\w+\s+ago)|just now|JSON|Copy)\s*$/gim,
        ""
      )
      .trim();
  }

  function readTurnText(item, excludeSel) {
    if (!item) return "";
    const md = proseOf(item);
    let txt = "";
    if (md && (!excludeSel || !md.closest(excludeSel))) {
      txt = textWithout(md, excludeSel);
      // In Arena Agent Mode, a code card (<pre>) may sit as a sibling outside .prose
      for (const pre of item.querySelectorAll("pre")) {
        if (pre.closest(".zs-chip") || (excludeSel && pre.closest(excludeSel))) continue;
        if (!md.contains(pre)) {
          txt += "\n" + (pre.textContent || "") + "\n";
        }
      }
      if (!isUserItem(item)) {
        txt = cleanAgentAssistantText(txt);
      }
    } else if (isUserItem(item)) {
      txt = textWithout(item, excludeSel);
    } else {
      txt = cleanAgentAssistantText(textWithout(item, excludeSel));
    }
    if (
      item.dataset &&
      item.dataset.zs === "sys" &&
      !txt.includes(ZS.SYS_MARKER)
    ) {
      txt = ZS.SYS_MARKER + (txt ? "\n" + txt : "");
    } else if (
      isUserItem(item) &&
      txt.includes("ADDITIONAL RULES FOR THIS SITE") &&
      !txt.includes(ZS.SYS_MARKER)
    ) {
      txt = ZS.SYS_MARKER + "\n" + txt;
    }
    const extraLua = extractFallbackRobloxLua(item, txt);
    return extraLua ? txt + extraLua : txt;
  }

  function itemText(item) {
    return readTurnText(item, "");
  }

  function classifyText(item, excludeSel) {
    return readTurnText(item, excludeSel);
  }

  // ── DOM primitives ──────────────────────────────────────────────────────
  // Agent turn discovery scans the DOM; reuse it briefly across the many
  // watcher calls. Text is still read from live nodes, not cached strings.
  let _turnCache = null, _turnCacheAt = 0, _turnCachePath = "";
  function allItems() {
    const agent = /^\/agent(?:\b|\/)/i.test(location.pathname);
    if (agent && _turnCache && _turnCachePath === location.pathname &&
        Date.now() - _turnCacheAt < 500 &&
        _turnCache.every((el) => el.isConnected !== false)) return _turnCache.slice();
    const result = collectItems();
    if (agent) { _turnCache = result; _turnCacheAt = Date.now(); _turnCachePath = location.pathname; }
    return result.slice();
  }
  function collectItems() {
    const ol = listEl();
    const turns = domTurns();
    if (turns.length <= 1) return turns;
    if (ol) {
      const isRev =
        ol.classList.contains("flex-col-reverse") ||
        (typeof window.getComputedStyle === "function" &&
          getComputedStyle(ol).flexDirection === "column-reverse");
      return isRev ? turns.slice().reverse() : turns;
    }
    // For Agent Mode's <div> stack, verify visual top-to-bottom chronological order
    if (typeof turns[0].getBoundingClientRect === "function") {
      const r0 = turns[0].getBoundingClientRect();
      const rLast = turns[turns.length - 1].getBoundingClientRect();
      if (r0.height > 0 && rLast.height > 0 && r0.top > rLast.top + 10) {
        return turns.slice().reverse();
      }
    }
    return turns;
  }
  const assistantItems = () => allItems().filter(isAssistantItem);
  const assistantCount = () => assistantItems().length;
  const userCount = () => allItems().filter(isUserItem).length;

  const editorText = () => {
    const e = getEditor();
    if (!e) return "";
    return e.value != null ? e.value : e.textContent || "";
  };

  const lastAssistant = () => {
    const it = assistantItems();
    return it.length ? it[it.length - 1] : null;
  };

  const _idMap = new WeakMap();
  let _idSeq = 0;
  function lastAssistantId() {
    const it = lastAssistant();
    if (!it) return null;
    let id = _idMap.get(it);
    if (!id) { id = ++_idSeq; _idMap.set(it, id); }
    return id;
  }

  const chatIsEmpty = () => allItems().length === 0;
  const CONV_UUID_RE = /^\/(?:c|agent|agents|chat)\/[a-z0-9-]{8,}/i;
  const isFreshChat = () =>
    chatIsEmpty() && !CONV_UUID_RE.test(location.pathname) && !!getEditor();

  // ── Input lock ────────────────────────────────────────────────────────────
  // CRITICAL: Do NOT set contenteditable="false" on ProseMirror in Agent Mode!
  // Setting contenteditable="false" caused getEditor() and ProseMirror's text
  // insertion to fail right when startSession() called setInputLock(true).
  // Instead, use pointerEvents="none" on contenteditable (while ui.inputCover
  // masks the box), and readonly on <textarea>.
  function setInputLock(on) {
    const ed = getEditor();
    if (!ed) return;
    if (isContentEditable(ed)) {
      ed.style.pointerEvents = on ? "none" : "";
      return;
    }
    if (on) {
      if (!ed.dataset.zsPlaceholder) ed.dataset.zsPlaceholder = ed.getAttribute("placeholder") || "";
      ed.setAttribute("readonly", "");
      ed.setAttribute("placeholder", "⏳ Agent working… please wait");
    } else {
      ed.removeAttribute("readonly");
      if (ed.dataset.zsPlaceholder != null) ed.setAttribute("placeholder", ed.dataset.zsPlaceholder);
    }
  }

  // ── Action button (send / stop) ───────────────────────────────────────────
  const ariaOf = (b) => b.getAttribute("aria-label") || b.getAttribute("title") || "";
  const allButtons = () => [...document.querySelectorAll("button")].filter((b) => !b.closest("#zs-root"));
  const stopButton = () =>
    allButtons().find((b) => S.stopAria.test(ariaOf(b)) && b.offsetParent !== null) || null;
  // Strictly match S.sendAria ("Send message") so sendButton NEVER matches the
  // Cancel/Stop button during Arena Agent Mode's 2-second pre-stream thinking window.
  const sendButton = () => {
    const stop = stopButton();
    return allButtons().find((b) => b !== stop && S.sendAria.test(ariaOf(b)) && b.offsetParent !== null) || null;
  };

  // ── Generation detection ──────────────────────────────────────────────────
  function streamText(item) {
    if (!item) return "";
    return classifyText(item, ".zs-chip");
  }
  const streamLen = (item) => streamText(item === undefined ? lastAssistant() : item).length;

  let _streamMax = -1, _streamAt = 0, _streamItem = null;
  function sampleStream() {
    const item = lastAssistant();
    const len = streamText(item).length;
    const now = Date.now();
    if (item !== _streamItem || len < _streamMax - 400) {
      _streamItem = item; _streamMax = len; _streamAt = now; return;
    }
    if (len > _streamMax) { _streamMax = len; _streamAt = now; }
  }
  const grewWithin = (ms) => _streamMax > 1 && Date.now() - _streamAt < ms;

  const WEDGE_MS = 45000;
  let _stopSince = 0;
  function genActive() {
    sampleStream();
    const stop = !!stopButton();
    const now = Date.now();
    if (stop) {
      // Native Agent tool calls can run for minutes without changing the reply
      // text. A visible stop control means the agent is still working; never
      // treat that quiet period as a completed command and interrupt it.
      if (/^\/agent(?:\b|\/)/i.test(location.pathname)) return true;
      if (!_stopSince) _stopSince = now;
      return now - Math.max(_streamAt, _stopSince) < WEDGE_MS;
    }
    _stopSince = 0;
    return grewWithin(timings.GEN_IDLE_MS);
  }
  const isGenerating = genActive;
  const isBusyNow = genActive;
  const isHardGenerating = () => !!stopButton();

  const turnHalted = () => false;
  function findContinueBtn() {
    for (const b of document.querySelectorAll("button")) {
      if (b.closest && b.closest("#zs-root, nav, aside, header, [data-sidebar]")) continue;
      if (b.offsetParent === null) continue;
      if (b.disabled || b.getAttribute("aria-disabled") === "true") continue;
      const lbl = (b.textContent || "").trim();
      const aria = ariaOf(b).trim();
      if (
        CONTINUE_BTN_RE.test(lbl) ||
        CONTINUE_BTN_RE.test(aria) ||
        CONT_A_RE.test(lbl) ||
        CONT_A_RE.test(aria)
      ) {
        return b;
      }
    }
    return null;
  }
  let _lastContinueClick = 0;
  function clickContinueBtn() {
    if (Date.now() - _lastContinueClick < 5000) return false;
    const b = findContinueBtn();
    if (!b) return false;
    try {
      b.click();
      _lastContinueClick = Date.now();
      return true;
    } catch {
      return false;
    }
  }

  function snapshot() {
    try {
      const it = lastAssistant();
      if (!it) return { th: 0, rp: 0 };
      const txt = classifyText(it, ".zs-chip");
      return { th: 0, rp: txt ? txt.length : 0 };
    } catch { return {}; }
  }

  function readAssistant() {
    const item = lastAssistant();
    if (!item) return { present: false, reply: "", thinking: "", item: null };
    return {
      present: true,
      reply: classifyText(item, ".zs-chip").trim(),
      thinking: "",
      item,
    };
  }

  async function waitFor(pred, timeout) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      if (pred()) return true;
      await sleep(120);
    }
    return false;
  }

  // ── Sending ───────────────────────────────────────────────────────────────
  const SEND_CAP = 120000;
  const SEND_MAX = 118000;
  function truncateForSend(text) {
    if (!text || text.length <= SEND_CAP) return text;
    const omitted = text.length - SEND_MAX;
    const marker =
      `\n\n[…UqBOAT: result truncated to fit Arena's input limit - ` +
      `${omitted} of ${text.length} characters omitted…]\n\n`;
    const budget = SEND_MAX - marker.length;
    const headLen = Math.floor(budget * 0.85);
    const tailLen = budget - headLen;
    return text.slice(0, headLen) + marker + text.slice(text.length - tailLen);
  }

  function setTextareaValue(el, v) {
    if (isContentEditable(el)) {
      el.setAttribute("contenteditable", "true");
      el.focus();
      let ok = false;
      try {
        document.execCommand("selectAll", false, null);
        const sel = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(el);
        sel.removeAllRanges();
        sel.addRange(range);
        ok = document.execCommand("insertText", false, v);
      } catch {}
      if (!ok) {
        el.textContent = v;
        el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: v }));
      }
      return;
    }
    const proto = window.HTMLTextAreaElement && window.HTMLTextAreaElement.prototype;
    const setter = proto && Object.getOwnPropertyDescriptor(proto, "value");
    if (setter && setter.set) setter.set.call(el, v);
    else el.value = v;
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }

  async function typeAndSend(text, images) {
    let editor = getEditor();
    if (!editor) {
      await waitFor(() => !!getEditor(), 10000);
      editor = getEditor();
    }
    if (!editor) throw new Error("Arena input box not found");
    editor.focus();
    setTextareaValue(editor, truncateForSend(text));
    if (images && images.length) tagImages(images);
    diag("arena.tas.enter", {
      textLen: (text || "").length,
      imgId: images ? images.__zsId : null,
      imgCount: images ? images.length : 0,
      attachedId: _attachedImages ? _attachedImages.__zsId : null,
      sameSet: images === _attachedImages,
      pendingBefore: pendingCount(),
    });
    const sendReady = () => {
      const b = sendButton();
      return !!b && !b.disabled && b.getAttribute("aria-disabled") !== "true";
    };
    const ready1 = await waitFor(sendReady, 60000);
    diag("arena.tas.ready", { ready: ready1 });
    if (images && images.length && images !== _attachedImages) {
      if (hasPendingAttachment()) { diag("arena.tas.clearStale", { pending: pendingCount() }); clearAttachments(); }
      try {
        const ok = await attachImages(images);
        if (ok) _attachedImages = images;
        diag("arena.tas.attached", { imgId: images.__zsId, ok, pendingAfter: pendingCount() });
      } catch (e) { diag("arena.tas.attachErr", { msg: String(e && e.message || e) }); }
      await waitFor(sendReady, 6000);
    } else {
      diag("arena.tas.skipAttach", { reason: !images || !images.length ? "no-images" : "same-set", imgId: images ? images.__zsId : null });
    }
    const preTurns = domTurns().length;
    let sent = false;
    for (let i = 0; i < 6 && !sent; i++) {
      if (sendReady()) {
        try { sendButton().click(); } catch {}
      } else if (!isHardGenerating() && i === 0) {
        const o = { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true };
        editor.dispatchEvent(new KeyboardEvent("keydown", o));
        editor.dispatchEvent(new KeyboardEvent("keyup", o));
      }
      sent = await waitFor(
        () =>
          editorText().trim() === "" ||
          domTurns().length > preTurns ||
          isHardGenerating(),
        1200
      );
    }
    diag("arena.tas.sent", { sent, editorLen: editorText().length, pendingAfterSend: pendingCount() });
  }

  let _stopPoll = null;
  function stopGeneration() {
    if (_stopPoll) { clearInterval(_stopPoll); _stopPoll = null; }
    const b = stopButton();
    if (b) { try { b.click(); } catch {} return; }
    const t0 = Date.now();
    _stopPoll = setInterval(() => {
      const btn = stopButton();
      if (btn) { try { btn.click(); } catch {} clearInterval(_stopPoll); _stopPoll = null; return; }
      if (Date.now() - t0 > 8000) { clearInterval(_stopPoll); _stopPoll = null; }
    }, 120);
  }

  // ── Chat-mode gate (Direct AND Agent modes supported) ─────────────────────
  const MODE_RE = /\b(direct|battle|agent|side by side)\b/i;
  const SUPPORTED_MODES = new Set(["direct", "agent"]);
  function currentMode() {
    if (/^\/agent(?:\b|\/)/i.test(location.pathname)) return "agent";
    for (const c of document.querySelectorAll('button[role="combobox"]')) {
      if (c.closest("#zs-root") || c.offsetParent === null) continue;
      const m = (c.textContent || "").trim().toLowerCase().match(MODE_RE);
      if (m) return m[1];
    }
    return null; // unknown -> allow
  }

  const UNSUPPORTED_MODES = [
    { route: /^\/code\//, aria: "Code", label: "Build Apps", tip: "the <b>Code</b> button" },
    { route: /^\/search\//, aria: "Search", label: "Web Search", tip: "the <b>Search</b> (globe) button" },
    { route: /^\/image\//, aria: "Image", label: "Generate Image", tip: "the <b>Image</b> button" },
  ];
  function activeUnsupportedMode() {
    if (/^\/agent(?:\b|\/)/i.test(location.pathname)) return null;
    for (const m of UNSUPPORTED_MODES) {
      if (m.route.test(location.pathname)) return m;
      for (const b of document.querySelectorAll(`button[aria-label="${m.aria}"]`)) {
        if (b.offsetParent === null) continue;
        if (b.getAttribute("aria-pressed") === "true") return m;
        if (/bg-surface-tertiary|bg-surface-raised-alt/.test(b.className)) return m;
      }
    }
    return null;
  }

  const isSupportedMode = () => {
    if (/^\/agent(?:\b|\/)/i.test(location.pathname)) return true;
    if (activeUnsupportedMode()) return false;
    const m = currentMode();
    return m === null || SUPPORTED_MODES.has(m);
  };

  function pickDirectOption() {
    for (const o of document.querySelectorAll('[role="option"]')) {
      if (o.offsetParent === null) continue;
      if (/^\s*(?:direct|agent)/i.test(o.textContent || "")) { try { o.click(); } catch {} return true; }
    }
    return false;
  }
  async function restoreDirectOnce() {
    if (activeUnsupportedMode()) return;
    if (/^\/agent(?:\b|\/)/i.test(location.pathname)) return;
    let combo = null;
    for (let i = 0; i < 60 && !combo; i++) {
      combo = [...document.querySelectorAll('button[role="combobox"]')].find((x) => x.offsetParent !== null) || null;
      if (!combo) await sleep(250);
    }
    if (!combo || /direct|agent/i.test(combo.textContent || "")) return;
    if (combo.getAttribute("aria-expanded") !== "true") { try { combo.click(); } catch {} }
    const ok = await waitFor(pickDirectOption, 2000);
    diag("arena.restore_direct", { ok, was: (combo.textContent || "").trim().slice(0, 24) });
    if (!ok && combo.getAttribute("aria-expanded") === "true") { try { combo.click(); } catch {} }
  }

  function modeWarning() {
    const um = activeUnsupportedMode();
    if (um)
      return `Turn off <b>${um.label}</b> (${um.tip} in the composer) - ` +
        `UqBOAT works in Agent and Direct chat modes. ${um.label} mode uses a different ` +
        `output surface and breaks the agent loop.`;
    if (isSupportedMode()) return "";
    const m = currentMode();
    const name = m ? m.charAt(0).toUpperCase() + m.slice(1) : "another mode";
    return `Switch the mode dropdown to <b>Agent</b> or <b>Direct</b> - UqBOAT works in ` +
      `Agent and Direct modes (current: <b>${name}</b>).`;
  }

  const CAPTCHA_SEL =
    'iframe[src*="challenges.cloudflare.com"],' +
    'iframe[src*="hcaptcha.com"],' +
    'iframe[src*="recaptcha"],' +
    '.cf-turnstile,.h-captcha,.g-recaptcha';
  function reallyVisible(el) {
    for (let n = el; n && n !== document.documentElement; n = n.parentElement) {
      const s = getComputedStyle(n);
      if (s.display === "none" || s.visibility === "hidden" || parseFloat(s.opacity) === 0) return false;
    }
    const r = el.getBoundingClientRect();
    if (r.width < 40 || r.height < 40) return false;
    return r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth;
  }
  function captchaPresent() {
    for (const el of document.querySelectorAll(CAPTCHA_SEL)) {
      if (reallyVisible(el)) return true;
    }
    return false;
  }

  function overlayBlocking() {
    const anchor = barAnchor();
    const ar = anchor ? anchor.getBoundingClientRect() : null;
    for (const d of document.querySelectorAll('[role="dialog"][aria-modal="true"], [role="alertdialog"]')) {
      if (d.closest("#zs-root")) continue;
      if (!reallyVisible(d)) continue;
      if (!ar || !ar.width) return true;
      const r = d.getBoundingClientRect();
      const overlapsHoriz = r.right > ar.left + 20 && r.left < ar.right - 20;
      const overlapsVert = r.bottom > ar.top - 40 && r.top < ar.bottom + 20;
      if (overlapsHoriz && overlapsVert) return true;
    }
    return false;
  }

  function enforceComposer() {
    resolveBattle();
    return { ready: true };
  }
  async function ensureComposerReady(reason) {
    for (let i = 0; i < 15 && !getEditor(); i++) {
      await sleep(100);
    }
    const ed = getEditor();
    const supported = isSupportedMode();
    diag("mode_ready", { reason, provider: "arena", mode: currentMode(), supported, hasEd: !!ed });
    return { ready: !!ed };
  }

  // ── Error / limit detection ───────────────────────────────────────────────
  function scanError() {
    try {
      for (const el of document.querySelectorAll(S.errorSurfaces)) {
        if (el.offsetParent === null) continue;
        if (el.closest(S.list)) continue;
        const t = (el.innerText || "").trim();
        if (t.length > 8 && t.length < 600 && RE.contextLimit.test(t)) return t.slice(0, 240);
      }
    } catch {}
    return null;
  }
  const isTooLongMsg = (text) => RE.tooLong.test(text);
  const isBusyMsg = (text) => RE.busy.test(text);

  // ── Image attachment ──────────────────────────────────────────────────────
  function fileFromImage(img, i) {
    const mime = img.mimeType || "image/jpeg";
    const bin = atob(img.data);
    const arr = new Uint8Array(bin.length);
    for (let j = 0; j < bin.length; j++) arr[j] = bin.charCodeAt(j);
    const ext = mime.includes("png") ? "png" : mime.includes("webp") ? "webp" : "jpg";
    return new File([arr], `uqboat_${Date.now()}_${i}.${ext}`, { type: mime });
  }
  const pendingPreview = () => {
    const frame = composerFrame();
    return frame ? frame.querySelector(".flex.flex-wrap.gap-2 img, img[src^='blob:']") : null;
  };
  const hasPendingAttachment = () => !!pendingPreview();
  const pendingCount = () => {
    const frame = composerFrame();
    return frame ? frame.querySelectorAll(".flex.flex-wrap.gap-2 img, img[src^='blob:']").length : 0;
  };
  let _imgSeq = 0;
  function tagImages(images) {
    if (images && images.__zsId == null) {
      try { Object.defineProperty(images, "__zsId", { value: ++_imgSeq, enumerable: false }); } catch { images.__zsId = ++_imgSeq; }
    }
    return images;
  }
  function fileInputEl() {
    const frame = composerFrame();
    return (frame && frame.querySelector('input[type="file"]')) || document.querySelector('input[type="file"]');
  }
  async function attachImages(images) {
    const inp = fileInputEl();
    if (!inp || !images || !images.length) return false;
    const dt = new DataTransfer();
    images.forEach((img, i) => { try { dt.items.add(fileFromImage(img, i)); } catch {} });
    if (!dt.items.length) return false;
    try {
      inp.files = dt.files;
      inp.dispatchEvent(new Event("change", { bubbles: true }));
    } catch { return false; }
    diag("attach.set", { count: dt.items.length });
    const ok = await waitFor(hasPendingAttachment, 15000);
    diag("attach.preview", { ok });
    return ok;
  }
  function clearAttachments() {
    try {
      const frame = composerFrame();
      if (!frame) return;
      frame.querySelectorAll('.flex.flex-wrap.gap-2 button[aria-label="Remove file"], button[aria-label*="Remove" i]')
        .forEach((d) => { try { d.click(); } catch {} });
    } catch {}
  }

  // Only a real conversation UUID route (/c/<uuid>, /agent/<uuid>, /chat/<uuid>)
  // is persisted; landing routes (/text/*, /agent, /) return "".
  const conversationKey = () => (CONV_UUID_RE.test(location.pathname) ? location.pathname : "");

  // ── User-send interception ────────────────────────────────────────────────
  function installSendHooks(handlers) {
    document.addEventListener(
      "keydown",
      (e) => {
        if (e.key !== "Enter" || e.shiftKey || e.isComposing) return;
        const editor = getEditor();
        if (!editor || !editor.contains(e.target)) return;
        if (editorText().trim() === "") return;
        if (handlers.isBlocked()) return;
        if (!handlers.isStarted()) {
          if (!chatIsEmpty()) return;
          handlers.onBlockedAttempt();
          return;
        }
        handlers.onUserMessage(assistantCount());
      },
      true
    );

    document.addEventListener(
      "click",
      (e) => {
        if (!getEditor()) return;
        const btn = e.target && e.target.closest && e.target.closest("button");
        if (!btn) return;
        if (S.stopAria.test(ariaOf(btn))) { handlers.onNativeStop(); return; }
        if (!S.sendAria.test(ariaOf(btn)) && btn !== sendButton()) return;
        if (btn.disabled || btn.getAttribute("aria-disabled") === "true") return;
        if (handlers.isBlocked()) return;
        if (!handlers.isStarted()) {
          if (!chatIsEmpty()) return;
          handlers.onBlockedAttempt();
          return;
        }
        handlers.onUserMessage(assistantCount());
      },
      true
    );
  }

  // ── Tool-block location for camouflage ────────────────────────────────────
  const CMD_SHAPE = /"(?:command|tool)"\s*:\s*"|###\s*lua|###mcp_tool###/i;
  function findToolBlockSpot(item /*, chip */) {
    if (!item) return null;
    const nodes = proseNodesOf(item);
    const roots = nodes.length ? nodes : [proseOf(item) || item].filter(Boolean);
    let hidAny = null;
    for (const md of roots) {
      md.querySelectorAll(S.codeWrap).forEach((cw) => {
        if (cw.closest(".zs-chip")) return;
        const t = cw.textContent || "";
        if (CMD_SHAPE.test(t) || (!/^\/agent(?:\b|\/)/i.test(location.pathname) && ROBLOX_LUA_RE.test(t))) {
          cw.classList.add("zs-tool-hide");
          item.classList.add("zs-cmd-mask");
          hidAny = hidAny || { parent: cw.parentElement, ref: cw };
        }
      });
      [...md.children].forEach((el) => {
        if (el.classList.contains("zs-chip") || el.querySelector(S.codeWrap)) return;
        const t = el.textContent || "";
        if (t.length < 600 && CMD_SHAPE.test(t)) {
          el.classList.add("zs-tool-hide");
          item.classList.add("zs-cmd-mask");
          hidAny = hidAny || { parent: el.parentElement, ref: el };
        }
      });
    }
    // Also check standalone <pre> cards in Arena Agent Mode (e.g. "{} JSON" card)
    item.querySelectorAll("pre").forEach((pre) => {
      if (pre.closest(".zs-chip") || pre.closest(".zs-tool-hide")) return;
      const t = pre.textContent || "";
      if (CMD_SHAPE.test(t) || (!/^\/agent(?:\b|\/)/i.test(location.pathname) && ROBLOX_LUA_RE.test(t))) {
        let card = pre;
        if (
          pre.parentElement &&
          pre.parentElement !== item &&
          (pre.parentElement.textContent || "").length - t.length < 40
        ) {
          card = pre.parentElement;
        }
        card.classList.add("zs-tool-hide");
        item.classList.add("zs-cmd-mask");
        hidAny = hidAny || { parent: card.parentElement, ref: card };
      }
    });
    return hidAny;
  }

  const PROMPT_EXTRA = [
    "- ARENA.AI AGENT MODE & STUDIO SYNC RULES:",
    "  1. You are connected LIVE to the user's Roblox Studio on their PC via the UqBOAT browser extension.",
    "  2. Arena native tools and connectors, including GitHub when connected, remain available for research, downloads and workspace files. Use them normally when appropriate; do not substitute UqBOAT MCP discovery for checking a native connector.",
    "  3. Arena's cloud workspace is separate from the user's local Studio. Use native tools to retrieve or inspect material, then emit explicit UqBOAT fenced command blocks to inspect or change Roblox Studio. Do not treat ordinary source code shown in a native tool result as an executable Studio command.",
  ].join("\n");

  return {
    id: "arena",
    displayName: "Arena",
    isAgentMode: () => /^\/agent(?:\b|\/)/i.test(location.pathname),
    supportsVision: true,
    timings,
    promptExtra: PROMPT_EXTRA,
    chipAtItemLevel: true,
    chipAnchor,
    chipAppend: true,
    reliableCounts: true,
    init({ diag: d } = {}) { if (d) diag = d; try { restoreDirectOnce(); } catch {} },
    // turns
    allItems, isUserItem, isAssistantItem, itemText, classifyText,
    assistantCount, userCount, lastAssistant, lastAssistantId, readAssistant,
    streamLen, snapshot,
    // composer / state
    getEditor, editorText, chatIsEmpty, isFreshChat, composerFrame, barAnchor,
    setInputLock, typeAndSend, stopGeneration,
    isGenerating, isBusyNow, isHardGenerating,
    enforceComposer, ensureComposerReady, modeWarning, captchaPresent, overlayBlocking,
    turnHalted, findContinueBtn, clickContinueBtn,
    scanError, isTooLongMsg, isBusyMsg,
    // actions
    attachImages, clearAttachments, conversationKey,
    installSendHooks, findToolBlockSpot,
  };
})();
