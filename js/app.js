(function () {
  "use strict";

  // ---------- Storage ----------
  const KEY = "canto-learner-v1";
  const DEFAULT_SETTINGS = {
    showHanzi: true,
    jpOnFront: true,
    colorTones: true,
    mode: "auto",          // auto | read | recall | listen | mix
    newPerDay: 10,
    autoplay: true,
    rate: 0.85,
    voiceURI: "",
  };

  function freshState() {
    return {
      v: 1,
      settings: { ...DEFAULT_SETTINGS },
      cards: {},
      decks: {},            // deckId -> enabled (overrides default)
      daily: { day: 0, newCount: 0, reviewCount: 0 },
      streak: { last: 0, count: 0 },
      toneQuiz: { right: 0, total: 0 },
    };
  }

  function load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return freshState();
      const s = JSON.parse(raw);
      const base = freshState();
      return { ...base, ...s, settings: { ...base.settings, ...(s.settings || {}) } };
    } catch (e) {
      return freshState();
    }
  }

  let state = load();
  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(state)); }
    catch (e) { toast("Couldn't save progress on this device"); }
  }

  // ---------- Utils ----------
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  function today() {
    const d = new Date();
    return Math.floor((d.getTime() - d.getTimezoneOffset() * 60000) / 86400000);
  }

  function rollDaily() {
    const t = today();
    if (state.daily.day !== t) state.daily = { day: t, newCount: 0, reviewCount: 0 };
  }

  let toastTimer;
  function toast(msg) {
    const el = $("#toast");
    el.textContent = msg;
    el.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove("show"), 2600);
  }

  function shuffle(a) {
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  // Render Jyutping with tone colours: "nei5 hou2" -> coloured syllables.
  function jp(text) {
    const color = state.settings.colorTones;
    return '<span class="jp">' + String(text).replace(/([a-z]+)([1-6])|([^a-z1-6]+)/gi, (m, syl, tone, other) => {
      if (other) return esc(other);
      return `<span class="syl${color ? " t" + tone : ""}">${esc(syl)}<sup>${tone}</sup></span>`;
    }) + "</span>";
  }

  // ---------- Content ----------
  const ALL_DECKS = [
    ...window.DECKS.map((d) => ({ ...d, kind: "vocab" })),
    ...window.PHRASES.map((d) => ({ ...d, kind: "phrase" })),
  ];
  const CARDS = [];
  const CARD_BY_ID = {};
  ALL_DECKS.forEach((d) => {
    d.items = d.cards.map(([h, j, e, note]) => {
      const c = { id: d.id + "|" + h, deck: d.id, h, j, e, note };
      CARDS.push(c);
      CARD_BY_ID[c.id] = c;
      return c;
    });
  });
  const DECK_BY_ID = Object.fromEntries(ALL_DECKS.map((d) => [d.id, d]));

  function deckEnabled(d) {
    if (d.id in state.decks) return state.decks[d.id];
    return d.kind === "vocab" || !!d.on;
  }

  // ---------- Spaced repetition ----------
  // A card's record: { ivl (days, 0 = still learning), ease, due (day number), reps, lapses }
  function cardStatus(id) {
    const r = state.cards[id];
    if (!r) return "new";
    return r.ivl >= 7 ? "known" : "learning";
  }

  function nextReview(rec, grade) {
    const r = rec ? { ...rec } : { ivl: 0, ease: 2.5, due: today(), reps: 0, lapses: 0 };
    let requeue = 0;
    if (r.ivl < 1) {
      // Learning: stay in today's session until "good" or "easy".
      if (grade === 0) requeue = 3;
      else if (grade === 1) requeue = 6;
      else if (grade === 2) r.ivl = 1;
      else r.ivl = 4;
    } else {
      if (grade === 0) {
        r.lapses += 1;
        r.ease = Math.max(1.3, r.ease - 0.2);
        r.ivl = 0;
        requeue = 3;
      } else if (grade === 1) {
        r.ease = Math.max(1.3, r.ease - 0.15);
        r.ivl = Math.max(r.ivl + 1, Math.round(r.ivl * 1.2));
      } else if (grade === 2) {
        r.ivl = Math.max(r.ivl + 1, Math.round(r.ivl * r.ease));
      } else {
        r.ease += 0.15;
        r.ivl = Math.max(r.ivl + 2, Math.round(r.ivl * r.ease * 1.3));
      }
    }
    r.reps += 1;
    r.due = today() + r.ivl;
    return { rec: r, requeue };
  }

  function ivlLabel(rec, grade) {
    const { rec: r, requeue } = nextReview(rec, grade);
    if (requeue) return "again soon";
    if (r.ivl < 30) return r.ivl + (r.ivl === 1 ? " day" : " days");
    if (r.ivl < 365) return Math.round(r.ivl / 30) + " mo";
    return (r.ivl / 365).toFixed(1) + " yr";
  }

  function dueCards() {
    const t = today();
    return CARDS.filter((c) => {
      const r = state.cards[c.id];
      return r && r.due <= t && deckEnabled(DECK_BY_ID[c.deck]);
    });
  }

  function newCardsAvailable() {
    rollDaily();
    const left = Math.max(0, state.settings.newPerDay - state.daily.newCount);
    // Take new words from each switched-on list in turn, so a day mixes topics.
    const lists = ALL_DECKS.filter(deckEnabled).map((d) => d.items.filter((c) => !state.cards[c.id]));
    const pool = [];
    for (let i = 0; pool.length < left && lists.some((l) => i < l.length); i++) {
      lists.forEach((l) => { if (i < l.length && pool.length < left) pool.push(l[i]); });
    }
    return pool;
  }

  function bumpStreak() {
    const t = today();
    if (state.streak.last === t) return;
    state.streak.count = state.streak.last === t - 1 ? state.streak.count + 1 : 1;
    state.streak.last = t;
  }

  function currentStreak() {
    const t = today();
    return state.streak.last >= t - 1 ? state.streak.count : 0;
  }

  // ---------- Speech ----------
  let voices = [];
  let cantoVoice = null;
  const synth = "speechSynthesis" in window ? window.speechSynthesis : null;

  function isCanto(v) {
    return /^(zh[-_]HK|yue)/i.test(v.lang) || /cantonese|粵|廣東|hong kong/i.test(v.name);
  }

  function refreshVoices() {
    if (!synth) return;
    voices = synth.getVoices();
    const canto = voices.filter(isCanto);
    cantoVoice = canto.find((v) => v.voiceURI === state.settings.voiceURI) || canto[0] || null;
  }

  if (synth) {
    refreshVoices();
    synth.onvoiceschanged = () => {
      const had = !!cantoVoice;
      refreshVoices();
      if (had !== !!cantoVoice) route();
    };
  }

  function speak(text) {
    if (!synth) { toast("Audio isn't supported in this browser"); return; }
    const clean = String(text).replace(/[…]/g, "");
    synth.cancel();
    const u = new SpeechSynthesisUtterance(clean);
    u.lang = "zh-HK";
    if (cantoVoice) u.voice = cantoVoice;
    u.rate = state.settings.rate;
    synth.speak(u);
    if (!cantoVoice && !speak.warned) {
      speak.warned = true;
      toast("No Cantonese voice found. See More → Settings for how to add one.");
    }
  }

  function playBtn(text, label = "Play") {
    return `<button class="icon-btn" data-say="${esc(text)}" aria-label="${esc(label)}" title="${esc(label)}">🔊</button>`;
  }

  document.addEventListener("click", (e) => {
    const b = e.target.closest("[data-say]");
    if (b) { e.stopPropagation(); speak(b.dataset.say); }
  });

  function voiceNotice() {
    if (cantoVoice) return "";
    return `<div class="notice"><b>No Cantonese voice on this device yet.</b> Audio may play in Mandarin or not at all.
      <a href="#settings">How to add one</a>.</div>`;
  }

  // ---------- Views ----------
  const view = $("#view");
  let keyHandler = null;

  function render(html, tab) {
    keyHandler = null;
    view.innerHTML = html;
    $$(".tabbar a").forEach((a) => a.classList.toggle("active", a.dataset.tab === tab));
    window.scrollTo(0, 0);
  }

  function homeView() {
    rollDaily();
    const due = dueCards().length;
    const fresh = newCardsAvailable().length;
    const learned = Object.keys(state.cards).length;
    const known = CARDS.filter((c) => cardStatus(c.id) === "known").length;
    const total = due + fresh;
    render(`
      ${new Date().getHours() < 12
        ? `<h1><span class="hanzi">早晨！</span> <span class="small">${jp("zou2 san4")} <span class="muted">good morning</span></span></h1>`
        : `<h1><span class="hanzi">你好！</span> <span class="small">${jp("nei5 hou2")} <span class="muted">hello</span></span></h1>`}
      ${voiceNotice()}
      <div class="card">
        <h2 style="margin-top:0">Today</h2>
        <p class="muted">${due} review${due === 1 ? "" : "s"} due and ${fresh} new word${fresh === 1 ? "" : "s"} ready.</p>
        <a class="btn primary block" href="#study">${total ? `Study ${total} card${total === 1 ? "" : "s"}` : "Nothing due, practise anyway"}</a>
      </div>
      <div class="grid">
        <div class="card stat"><b>${currentStreak()}</b><span>day streak</span></div>
        <div class="card stat"><b>${learned}</b><span>words started</span></div>
        <div class="card stat"><b>${known}</b><span>well known</span></div>
        <div class="card stat"><b>${CARDS.length}</b><span>in the course</span></div>
      </div>
      <h2>Where to start</h2>
      <div class="card menu">
        <a href="#tones"><span>1. Learn the six tones</span><span>›</span></a>
        <a href="#guide"><span>2. How to read Jyutping</span><span>›</span></a>
        <a href="#study"><span>3. Daily flashcards</span><span>›</span></a>
        <a href="#phrases"><span>4. Phrases for family and kids</span><span>›</span></a>
      </div>
    `, "home");
  }

  // ----- Study session -----
  let session = null;

  function startSession(practice) {
    rollDaily();
    let reviews = shuffle(dueCards().map((c) => c.id));
    let news = newCardsAvailable().map((c) => c.id);
    if (practice && !reviews.length && !news.length) {
      // Extra practice: a few random cards already started.
      reviews = shuffle(Object.keys(state.cards).filter((id) => CARD_BY_ID[id])).slice(0, 15);
    }
    // Spread new cards through the reviews.
    const queue = [...reviews];
    const step = news.length ? Math.max(1, Math.floor(queue.length / news.length)) : 1;
    news.forEach((id, i) => queue.splice(Math.min(queue.length, i * (step + 1)), 0, id));
    session = { queue, i: 0, done: 0, total: queue.length, again: 0, practice: !!practice, revealed: false, mode: null };
  }

  function pickMode(id) {
    let m = state.settings.mode;
    if (m === "auto") {
      // New words: recognise first. Reviews: mostly practise saying them.
      const r = state.cards[id];
      if (!r || r.reps < 2) m = "read";
      else m = ["recall", "recall", "listen", "read"][Math.floor(Math.random() * 4)];
    }
    if (m === "mix") m = ["read", "recall", "listen"][Math.floor(Math.random() * 3)];
    if (m === "listen" && !cantoVoice) m = state.settings.mode === "listen" ? "read" : "recall";
    return m;
  }

  function studyView(practice) {
    if (!session || session.i >= session.queue.length || practice) startSession(practice);
    if (!session.queue.length) {
      render(`
        <div class="empty card">
          <div class="big">好嘢！</div>
          <p><b>hou2 je5!</b> Great job, you're all caught up.</p>
          <p class="muted">Come back tomorrow for more reviews and new words, or turn on more word lists.</p>
          <div class="btn-row" style="justify-content:center">
            <a class="btn" href="#practice">Extra practice</a>
            <a class="btn" href="#decks">Word lists</a>
          </div>
        </div>`, "study");
      return;
    }
    if (session.i >= session.queue.length) return summaryView();
    session.revealed = false;
    session.mode = pickMode(session.queue[session.i]);
    drawCard();
  }

  function cardFront(c, mode) {
    const s = state.settings;
    if (mode === "recall") {
      return `<div class="prompt-en">${esc(c.e)}</div><div class="muted small">Say it in Cantonese</div>`;
    }
    if (mode === "listen") {
      return `<button class="btn" data-say="${esc(c.h)}" style="font-size:1.4rem;min-width:120px">🔊 Listen</button>
              <div class="muted small">What does it mean?</div>`;
    }
    const showJp = !s.showHanzi || s.jpOnFront;
    return `${s.showHanzi ? `<div class="big hanzi">${esc(c.h)}</div>` : ""}
            ${showJp ? `<div class="jp-line">${jp(c.j)}</div>` : ""}`;
  }

  function cardBack(c) {
    return `<div class="big hanzi">${esc(c.h)}</div>
            <div class="jp-line">${jp(c.j)}</div>
            <hr>
            <div class="en">${esc(c.e)}</div>
            ${c.note ? `<div class="note">${esc(c.note)}</div>` : ""}`;
  }

  function drawCard() {
    const id = session.queue[session.i];
    const c = CARD_BY_ID[id];
    const rec = state.cards[id];
    const isNew = !rec;
    const pct = session.total ? Math.round((session.done / session.total) * 100) : 0;
    const remaining = session.queue.length - session.i;
    const deck = DECK_BY_ID[c.deck];

    const body = session.revealed ? cardBack(c) : cardFront(c, session.mode);
    const controls = session.revealed
      ? `<div class="grades">
           <button class="btn again" data-grade="0">Again<small>${ivlLabel(rec, 0)}</small></button>
           <button class="btn" data-grade="1">Hard<small>${ivlLabel(rec, 1)}</small></button>
           <button class="btn good" data-grade="2">Good<small>${ivlLabel(rec, 2)}</small></button>
           <button class="btn" data-grade="3">Easy<small>${ivlLabel(rec, 3)}</small></button>
         </div>`
      : `<button class="btn primary block" id="reveal">Show answer</button>`;

    render(`
      <div style="display:flex;justify-content:space-between;align-items:center">
        <span class="muted small">${remaining} left${session.practice ? " · practice" : ""}</span>
        <a href="#home" class="small">End</a>
      </div>
      <div class="progress"><div style="width:${pct}%"></div></div>
      <div class="card flash" id="flash">
        <div class="deck-tag">${esc(deck.name)}${isNew ? " · new" : ""}</div>
        ${body}
        ${session.revealed || session.mode !== "listen" ? `<div>${playBtn(c.h)}</div>` : ""}
      </div>
      ${controls}
      <p class="kbd-hint muted small">Space: show · 1–4: grade · P: play</p>
    `, "study");

    const reveal = () => { if (!session.revealed) { session.revealed = true; drawCard(); } };
    $("#flash").addEventListener("click", (e) => { if (!e.target.closest("[data-say]")) reveal(); });
    const rb = $("#reveal");
    if (rb) rb.addEventListener("click", reveal);
    $$("[data-grade]").forEach((b) => b.addEventListener("click", () => grade(+b.dataset.grade)));

    keyHandler = (e) => {
      if (e.key === " " || e.key === "Enter") { e.preventDefault(); reveal(); }
      else if (/^[1-4]$/.test(e.key) && session.revealed) grade(+e.key - 1);
      else if (e.key.toLowerCase() === "p") speak(c.h);
    };

    const s = state.settings;
    if (s.autoplay && ((session.mode === "listen" && !session.revealed) || (session.revealed && session.mode !== "listen"))) {
      setTimeout(() => speak(c.h), 120);
    }
  }

  function grade(g) {
    const id = session.queue[session.i];
    const rec = state.cards[id];
    rollDaily();
    if (!rec) state.daily.newCount += 1;
    else state.daily.reviewCount += 1;
    const { rec: next, requeue } = nextReview(rec, g);
    state.cards[id] = next;
    if (g === 0) session.again += 1;
    if (requeue) {
      session.queue.splice(Math.min(session.queue.length, session.i + 1 + requeue), 0, id);
      session.total += 1;
    }
    session.done += 1;
    session.i += 1;
    bumpStreak();
    save();
    if (session.i >= session.queue.length) summaryView();
    else { session.revealed = false; session.mode = pickMode(session.queue[session.i]); drawCard(); }
  }

  function summaryView() {
    const n = session.done;
    session = null;
    render(`
      <div class="empty card">
        <div class="big">做得好！</div>
        <p>${jp("zou6 dak1 hou2!")} Well done.</p>
        <p>You reviewed <b>${n}</b> card${n === 1 ? "" : "s"}. Streak: <b>${currentStreak()}</b> day${currentStreak() === 1 ? "" : "s"}.</p>
        <div class="btn-row" style="justify-content:center">
          <a class="btn primary" href="#home">Home</a>
          <a class="btn" href="#practice">Extra practice</a>
        </div>
      </div>`, "study");
  }

  // ----- Word lists -----
  function decksView() {
    const row = (d) => {
      const learned = d.items.filter((c) => state.cards[c.id]).length;
      return `<div class="deck-row">
        <div class="main"><a href="#deck/${d.id}">${esc(d.name)}</a>
          <div class="muted small">${learned} / ${d.items.length} started</div></div>
        <label class="switch" title="Include in flashcards"><input type="checkbox" data-deck="${d.id}" ${deckEnabled(d) ? "checked" : ""} aria-label="Include ${esc(d.name)} in flashcards"><span></span></label>
      </div>`;
    };
    render(`
      <h1>Word lists</h1>
      <p class="muted">Switch a list on to include it in your daily flashcards. Each day mixes new words from every list that is on.</p>
      <h2>Vocabulary</h2>
      <div class="card">${ALL_DECKS.filter((d) => d.kind === "vocab").map(row).join("")}</div>
      <h2>Phrases</h2>
      <div class="card">${ALL_DECKS.filter((d) => d.kind === "phrase").map(row).join("")}</div>
    `, "more");
    bindDeckToggles();
  }

  function bindDeckToggles() {
    $$("[data-deck]").forEach((cb) => cb.addEventListener("change", () => {
      state.decks[cb.dataset.deck] = cb.checked;
      save();
      toast(cb.checked ? "Added to flashcards" : "Removed from flashcards");
    }));
  }

  function itemList(items, showStatus) {
    return `<ul class="list">${items.map((c) => `
      <li>
        ${showStatus ? `<span class="status-dot ${cardStatus(c.id)}" title="${cardStatus(c.id)}"></span>` : ""}
        <div class="main">
          <div class="h hanzi">${esc(c.h)}</div>
          <div>${jp(c.j)}</div>
          <div class="en">${esc(c.e)}</div>
          ${c.note ? `<div class="note">${esc(c.note)}</div>` : ""}
        </div>
        ${playBtn(c.h)}
      </li>`).join("")}</ul>`;
  }

  function deckView(id) {
    const d = DECK_BY_ID[id];
    if (!d) return decksView();
    render(`
      <p><a href="#decks">‹ Word lists</a></p>
      <h1>${esc(d.name)}</h1>
      <div class="setting"><label for="dk">Include in flashcards</label>
        <span class="switch"><input id="dk" type="checkbox" data-deck="${d.id}" ${deckEnabled(d) ? "checked" : ""}><span></span></span></div>
      <p class="legend muted"><span><span class="status-dot" style="display:inline-block"></span> new</span>
        <span><span class="status-dot learning" style="display:inline-block"></span> learning</span>
        <span><span class="status-dot known" style="display:inline-block"></span> well known</span></p>
      <div class="card">${itemList(d.items, true)}</div>
    `, "more");
    bindDeckToggles();
  }

  // ----- Phrases -----
  function phrasesView() {
    const phraseDecks = ALL_DECKS.filter((d) => d.kind === "phrase");
    render(`
      <h1>Phrases</h1>
      <p class="muted">Tap 🔊 to hear a phrase. Switch a group on to add it to your flashcards.</p>
      ${voiceNotice()}
      ${phraseDecks.map((d) => `
        <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;margin-top:20px">
          <h2 style="margin:0">${esc(d.name)}</h2>
          <label class="switch" title="Add to flashcards"><input type="checkbox" data-deck="${d.id}" ${deckEnabled(d) ? "checked" : ""} aria-label="Add ${esc(d.name)} to flashcards"><span></span></label>
        </div>
        <div class="card">${itemList(d.items, false)}</div>`).join("")}
      <h2>Little words that change everything</h2>
      <div class="card">
        <p>Cantonese uses sentence-final particles to add tone of voice. A few to recognise:</p>
        <ul class="list">
          <li><div class="main"><span class="hanzi h">呀</span> ${jp("aa3")}<div class="en">softens a question or statement</div></div>${playBtn("呀")}</li>
          <li><div class="main"><span class="hanzi h">啦</span> ${jp("laa1")}<div class="en">suggestion or urging: 走啦 "let's go"</div></div>${playBtn("走啦")}</li>
          <li><div class="main"><span class="hanzi h">喇</span> ${jp("laa3")}<div class="en">something has changed: 夠喇 "that's enough now"</div></div>${playBtn("夠喇")}</li>
          <li><div class="main"><span class="hanzi h">咩</span> ${jp("me1")}<div class="en">surprised question: 真係咩？ "really?!"</div></div>${playBtn("真係咩")}</li>
          <li><div class="main"><span class="hanzi h">咗</span> ${jp("zo2")}<div class="en">after a verb: done/completed: 食咗 "ate"</div></div>${playBtn("食咗")}</li>
        </ul>
      </div>
    `, "phrases");
    bindDeckToggles();
  }

  // ----- Tones -----
  function contourSvg(t, size = 64) {
    const pad = 8, w = size, h = size;
    const y = (lvl) => pad + (5 - lvl) * ((h - pad * 2) / 4);
    const [a, b] = t.contour;
    const lines = [1, 2, 3, 4, 5].map((l) => `<line x1="${pad}" x2="${w - pad}" y1="${y(l)}" y2="${y(l)}" stroke="currentColor" stroke-opacity=".12"/>`).join("");
    return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" aria-hidden="true" style="color:var(--t${t.n})">
      ${lines}
      <path d="M${pad + 4} ${y(a)} C ${w / 2} ${y(a)}, ${w / 2} ${y(b)}, ${w - pad - 4} ${y(b)}" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round"/>
    </svg>`;
  }

  let quiz = null;
  function newQuizQ() {
    const set = window.TONE_SETS[Math.floor(Math.random() * window.TONE_SETS.length)];
    const idx = Math.floor(Math.random() * 6);
    quiz = { set, idx, answered: null };
  }

  function tonesView() {
    if (!quiz) newQuizQ();
    const sets = window.TONE_SETS.map((s) => `
      <h3>${jp(s.items.map((i) => i[1]).join(" "))}</h3>
      <div class="set-row">${s.items.map(([h, j, e]) => `
        <button data-say="${esc(h)}" aria-label="${esc(j + ", " + e)}">
          <span class="hanzi">${esc(h)}</span>${jp(j)}<span class="gloss">${esc(e)}</span>
        </button>`).join("")}</div>`).join("");

    const tq = state.toneQuiz;
    render(`
      <h1>The six tones</h1>
      <p>Cantonese is tonal: the pitch of a syllable changes its meaning. Jyutping marks the tone with a number from 1 to 6 at the end of each syllable.
      The same sound <b>si</b> means six different things:</p>
      ${voiceNotice()}
      <div class="tone-grid">${window.TONES.map((t) => `
        <div class="card tone-card">
          ${contourSvg(t)}
          <div><div class="tone-num jp"><span class="t${t.n}">Tone ${t.n}</span></div>
            <div><b>${esc(t.name)}</b></div>
            <div class="muted small">${esc(t.desc)}</div></div>
        </div>`).join("")}</div>

      <h2>Hear the difference</h2>
      <p class="muted small">Tap each character. Listen for the pitch, not the sound.</p>
      ${sets}

      <h2>Tone quiz</h2>
      <div class="card" id="quiz">
        <p>Play the sound, then pick its tone.</p>
        <div class="btn-row">
          <button class="btn primary" id="qplay">🔊 Play</button>
          <button class="btn" id="qnext">Next</button>
          <span class="muted small" style="align-self:center">Score: ${tq.right} / ${tq.total}</span>
        </div>
        <div class="quiz-choices">${[1, 2, 3, 4, 5, 6].map((n) => `<button class="btn" data-tone="${n}">${n}</button>`).join("")}</div>
        <p id="qfeedback" class="small" style="min-height:1.5em"></p>
      </div>

      <h2>Checked tones</h2>
      <p>Syllables ending in <b>-p, -t, -k</b> are short and clipped. They only take tones 1, 3 and 6, e.g.
        <span class="hanzi">識</span> ${jp("sik1")} (know), <span class="hanzi">錫</span> ${jp("sek3")} (kiss), <span class="hanzi">食</span> ${jp("sik6")} (eat).</p>
      <p class="muted small">Tip: tone colours are used everywhere in the app so you start to see tones as well as hear them. You can turn them off in Settings.</p>
    `, "tones");

    const fb = $("#qfeedback");
    const item = () => quiz.set.items[quiz.idx];
    $("#qplay").addEventListener("click", () => speak(item()[0]));
    $("#qnext").addEventListener("click", () => { newQuizQ(); tonesView(); setTimeout(() => speak(item()[0]), 100); $("#quiz").scrollIntoView({ block: "center" }); });
    $$("[data-tone]").forEach((b) => b.addEventListener("click", () => {
      if (quiz.answered) return;
      const pick = +b.dataset.tone;
      const right = quiz.idx + 1;
      quiz.answered = pick;
      state.toneQuiz.total += 1;
      if (pick === right) state.toneQuiz.right += 1;
      save();
      b.classList.add(pick === right ? "right" : "wrong");
      $(`[data-tone="${right}"]`).classList.add("right");
      const [h, j, e] = item();
      fb.innerHTML = `${pick === right ? "Correct!" : "Not quite."} <span class="hanzi">${esc(h)}</span> ${jp(j)}, "${esc(e)}". Tap Next for another.`;
    }));
  }

  // ----- Jyutping guide -----
  function guideView() {
    const table = (rows, head) => `<table class="table"><thead><tr>${head.map((h) => `<th>${h}</th>`).join("")}</tr></thead><tbody>
      ${rows.map(([a, b, ex]) => {
        const exHtml = ex.split(", ").map((part) => {
          const [h, j] = part.split(" ");
          return `<span class="hanzi">${esc(h)}</span> ${jp(j)} ${playBtnInline(h)}`;
        }).join("<br>");
        return `<tr><td>${esc(a)}</td><td>${esc(b)}</td><td class="ex">${exHtml}</td></tr>`;
      }).join("")}</tbody></table>`;
    render(`
      <p><a href="#more">‹ More</a></p>
      <h1>Reading Jyutping</h1>
      <p>Jyutping is the standard way to write Cantonese sounds with the Latin alphabet. Each syllable has three parts:
        an <b>initial</b> (consonant), a <b>final</b> (vowel and ending), and a <b>tone number</b>.</p>
      <div class="card" style="text-align:center">
        <div class="hanzi" style="font-size:2.4rem">廣東話</div>
        <div style="font-size:1.3rem">${jp("gwong2 dung1 waa2")}</div>
        <div class="muted">Cantonese (the language) ${playBtnInline("廣東話")}</div>
      </div>
      <div class="notice">Watch out: Jyutping letters don't always sound like English. <b>j</b> is "y", <b>z</b> is "dz/j", <b>c</b> is "ts/ch",
        and <b>b, d, g</b> are unaspirated versions of p, t, k.</div>
      <h2>Initials</h2>
      <div class="card" style="overflow-x:auto">${table(window.INITIALS, ["Jyutping", "Sounds like", "Example"])}</div>
      <h2>Finals</h2>
      <div class="card" style="overflow-x:auto">${table(window.FINALS, ["Jyutping", "Sounds like", "Example"])}</div>
      <h2>Tones</h2>
      <p>The number at the end is the tone. <a href="#tones">Learn and practise the six tones</a>.</p>
    `, "more");
  }

  function playBtnInline(text) {
    return `<button class="icon-btn" style="width:30px;height:30px;font-size:.8rem;display:inline-grid;vertical-align:middle" data-say="${esc(text)}" aria-label="Play">🔊</button>`;
  }

  // ----- More & settings -----
  function moreView() {
    render(`
      <h1>More</h1>
      <div class="card menu">
        <a href="#decks"><span>Word lists</span><span>›</span></a>
        <a href="#guide"><span>Jyutping guide</span><span>›</span></a>
        <a href="#settings"><span>Settings & backup</span><span>›</span></a>
        <a href="#about"><span>How this app works</span><span>›</span></a>
      </div>
    `, "more");
  }

  function aboutView() {
    render(`
      <p><a href="#more">‹ More</a></p>
      <h1>How this app works</h1>
      <h2>Spaced repetition</h2>
      <p>Each day you get a few new words plus reviews of words you've seen. After you reveal a card, rate how well you knew it:</p>
      <ul>
        <li><b>Again</b>: you didn't know it. It comes back in a few cards.</li>
        <li><b>Hard</b>: you got it with effort. It comes back a little later.</li>
        <li><b>Good</b>: you knew it. The gap before the next review grows each time.</li>
        <li><b>Easy</b>: too easy. The gap grows faster.</li>
      </ul>
      <p>Fifteen minutes a day beats an hour once a week.</p>
      <h2>Study modes</h2>
      <p>By default, new words show Cantonese first so you can recognise them. Once you've seen a word a couple of times,
        most cards switch to English first: say the Cantonese <b>out loud</b> before you reveal. That's the habit that gets you talking.
        You can pick a fixed mode in Settings.</p>
      <h2>Your progress</h2>
      <p>Progress is saved in this browser only. To move it between your phone and laptop, use <a href="#settings">Settings → Backup</a>
        to copy a code from one device and paste it into the other.</p>
      <h2>Audio</h2>
      <p>Audio uses your device's built-in text-to-speech. Quality depends on the Cantonese voice installed.</p>
      <h2>Install it like an app</h2>
      <p><b>iPhone:</b> in Safari, tap Share → Add to Home Screen. <b>Android:</b> in Chrome, tap ⋮ → Add to Home screen.
        It works offline after the first visit.</p>
    `, "more");
  }

  function settingsView() {
    const s = state.settings;
    const canto = voices.filter(isCanto);
    const sw = (key, label, hint) => `
      <div class="setting"><label for="s-${key}">${label}${hint ? `<div class="muted small">${hint}</div>` : ""}</label>
        <span class="switch"><input id="s-${key}" type="checkbox" data-set="${key}" ${s[key] ? "checked" : ""}><span></span></span></div>`;

    render(`
      <p><a href="#more">‹ More</a></p>
      <h1>Settings</h1>
      <h2>Flashcards</h2>
      <div class="card">
        <div class="setting"><label for="s-mode">Card front</label>
          <select id="s-mode">
            ${[["auto", "Auto: recognise new words, then say them"], ["read", "Cantonese → English"], ["recall", "English → Cantonese"], ["listen", "Audio only (listening)"], ["mix", "Mix of all three"]]
              .map(([v, l]) => `<option value="${v}" ${s.mode === v ? "selected" : ""}>${l}</option>`).join("")}
          </select></div>
        <div class="setting"><label for="s-new">New words per day</label>
          <input id="s-new" type="number" min="0" max="50" value="${s.newPerDay}" style="width:80px"></div>
        ${sw("showHanzi", "Show Chinese characters", "Turn off to learn from Jyutping only")}
        ${sw("jpOnFront", "Show Jyutping on the front", "When off, you see only characters until you reveal")}
        ${sw("colorTones", "Colour Jyutping by tone")}
        ${sw("autoplay", "Play audio automatically")}
      </div>

      <h2>Audio</h2>
      <div class="card">
        <div class="setting"><label for="s-rate">Speed <span class="muted small" id="rate-val">${s.rate.toFixed(2)}×</span></label>
          <input id="s-rate" type="range" min="0.5" max="1.2" step="0.05" value="${s.rate}"></div>
        <div class="setting"><label for="s-voice">Voice</label>
          ${canto.length ? `<select id="s-voice">${canto.map((v) => `<option value="${esc(v.voiceURI)}" ${cantoVoice && v.voiceURI === cantoVoice.voiceURI ? "selected" : ""}>${esc(v.name)}</option>`).join("")}</select>`
            : `<span class="muted small">None found</span>`}</div>
        <div class="setting"><label>Test</label>${playBtn("你好，我哋一齊學廣東話啦！", "Test voice")}</div>
        ${canto.length ? "" : `
        <div class="notice">
          <b>Add a Cantonese voice:</b>
          <ul style="margin:6px 0;padding-left:18px">
            <li><b>iPhone/iPad:</b> Settings → Accessibility → Spoken Content → Voices → Chinese (Hong Kong). Download a voice such as Sinji.</li>
            <li><b>Mac:</b> System Settings → Accessibility → Spoken Content → System voice → Manage Voices → Chinese (Hong Kong).</li>
            <li><b>Android:</b> Settings → Google TTS → Install voice data → Cantonese (Hong Kong).</li>
            <li><b>Windows:</b> Settings → Time & language → Speech → Add voices → Chinese (Traditional, Hong Kong SAR).</li>
          </ul>
          Then reload this page. Chrome and Edge on desktop often include an online Cantonese voice too.
        </div>`}
      </div>

      <h2>Backup & sync</h2>
      <div class="card">
        <p class="small muted">Progress lives in this browser. Copy the code below and paste it into the app on your other device to move your progress.</p>
        <textarea id="export" readonly></textarea>
        <div class="btn-row" style="margin:8px 0 16px"><button class="btn" id="copy">Copy code</button></div>
        <textarea id="import" placeholder="Paste a backup code here"></textarea>
        <div class="btn-row" style="margin-top:8px"><button class="btn" id="do-import">Import</button></div>
      </div>

      <h2>Reset</h2>
      <div class="card">
        <p class="small muted">Erase all progress on this device. Settings are kept.</p>
        <button class="btn" id="reset">Reset progress</button>
      </div>
    `, "more");

    $$("[data-set]").forEach((cb) => cb.addEventListener("change", () => { s[cb.dataset.set] = cb.checked; save(); }));
    $("#s-mode").addEventListener("change", (e) => { s.mode = e.target.value; session = null; save(); });
    $("#s-new").addEventListener("change", (e) => {
      s.newPerDay = Math.max(0, Math.min(50, parseInt(e.target.value, 10) || 0));
      e.target.value = s.newPerDay; session = null; save();
    });
    $("#s-rate").addEventListener("input", (e) => { s.rate = +e.target.value; $("#rate-val").textContent = s.rate.toFixed(2) + "×"; save(); });
    const vs = $("#s-voice");
    if (vs) vs.addEventListener("change", () => { s.voiceURI = vs.value; refreshVoices(); save(); speak("你好"); });

    const ex = $("#export");
    ex.value = btoa(unescape(encodeURIComponent(JSON.stringify(state))));
    $("#copy").addEventListener("click", async () => {
      try { await navigator.clipboard.writeText(ex.value); toast("Copied"); }
      catch (e) { ex.select(); document.execCommand("copy"); toast("Copied"); }
    });
    $("#do-import").addEventListener("click", () => {
      const code = $("#import").value.trim();
      if (!code) return toast("Paste a code first");
      try {
        const data = JSON.parse(decodeURIComponent(escape(atob(code))));
        if (!data || data.v !== 1 || typeof data.cards !== "object") throw new Error("bad");
        state = { ...freshState(), ...data, settings: { ...DEFAULT_SETTINGS, ...data.settings } };
        session = null; save(); refreshVoices();
        toast("Progress imported");
        settingsView();
      } catch (e) { toast("That code didn't work. Copy it again and retry."); }
    });
    let armed = false;
    $("#reset").addEventListener("click", (e) => {
      if (!armed) { armed = true; e.target.textContent = "Tap again to erase everything"; e.target.style.borderColor = "#e03131"; return; }
      const settings = state.settings;
      state = freshState(); state.settings = settings; session = null; save();
      toast("Progress reset"); homeView();
    });
  }

  // ---------- Router ----------
  function route() {
    const h = location.hash.replace(/^#/, "") || "home";
    const [name, arg] = h.split("/");
    switch (name) {
      case "study": return studyView(false);
      case "practice": session = null; return studyView(true);
      case "tones": return tonesView();
      case "phrases": return phrasesView();
      case "decks": return decksView();
      case "deck": return deckView(arg);
      case "guide": return guideView();
      case "settings": return settingsView();
      case "about": return aboutView();
      case "more": return moreView();
      default: return homeView();
    }
  }

  window.addEventListener("hashchange", route);
  document.addEventListener("keydown", (e) => {
    if (keyHandler && !e.target.closest("input, textarea, select")) keyHandler(e);
  });
  route();

  if ("serviceWorker" in navigator && location.protocol === "https:") {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
})();
