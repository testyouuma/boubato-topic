"use strict";

// ----------------------------------------------------------------------------
// ユーティリティ
// ----------------------------------------------------------------------------
function fmtNum(n) {
  n = Number(n) || 0;
  if (n >= 10000) return (n / 10000).toFixed(n >= 100000 ? 0 : 1) + "万";
  return n.toLocaleString("ja-JP");
}

function fmtDuration(sec) {
  sec = Number(sec) || 0;
  if (!sec) return "";
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return m + ":" + String(s).padStart(2, "0");
}

function fmtDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d)) return "";
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}

function relDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d)) return "";
  const diff = (Date.now() - d.getTime()) / 1000;
  if (diff < 3600) return Math.floor(diff / 60) + "分前";
  if (diff < 86400) return Math.floor(diff / 3600) + "時間前";
  if (diff < 86400 * 30) return Math.floor(diff / 86400) + "日前";
  return fmtDate(iso);
}

function el(html) {
  const t = document.createElement("template");
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

function escapeHtml(s) {
  return String(s || "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

// ----------------------------------------------------------------------------
// カード生成
// ----------------------------------------------------------------------------
function card(item, opts = {}) {
  const isNico = item.source === "niconico";
  const badge = isNico ? "niconico" : "youtube";
  const badgeLabel = isNico ? "ニコニコ" : "YouTube";
  const rank = opts.rank ? `<span class="rank">#${opts.rank}</span>` : "";
  const dur =
    isNico && item.length_seconds
      ? `<span class="duration">${fmtDuration(item.length_seconds)}</span>`
      : "";

  const meta = [];
  meta.push(`▶ ${fmtNum(item.views)}`);
  if (isNico && item.mylists) meta.push(`📁 ${fmtNum(item.mylists)}`);
  if (!isNico && item.likes) meta.push(`👍 ${fmtNum(item.likes)}`);
  if (item.posted_at) meta.push(relDate(item.posted_at));
  const ch = !isNico && item.channel ? `<span class="ch">${escapeHtml(item.channel)}</span>` : "";

  const thumb = item.thumbnail
    ? `<img src="${escapeHtml(item.thumbnail)}" alt="" loading="lazy" referrerpolicy="no-referrer">`
    : "";

  return el(`
    <a class="card" href="${escapeHtml(item.url)}" target="_blank" rel="noopener">
      <div class="thumb-wrap">
        ${thumb}
        <span class="badge ${badge}">${badgeLabel}</span>
        ${rank}${dur}
      </div>
      <div class="card-body">
        <div class="card-title">${escapeHtml(item.title)}</div>
        <div class="card-meta">${ch}<span>${meta.join(" ・ ")}</span></div>
      </div>
    </a>
  `);
}

function renderGrid(container, items, opts = {}) {
  container.innerHTML = "";
  if (!items || !items.length) {
    container.innerHTML = `<p class="empty">${opts.emptyMsg || "データがありません。"}</p>`;
    return;
  }
  items.forEach((item, i) => {
    container.appendChild(card(item, opts.ranked ? { rank: i + 1 } : {}));
  });
}

// ----------------------------------------------------------------------------
// メイン描画
// ----------------------------------------------------------------------------
let DATA = null;

function renderPickup() {
  const grid = document.getElementById("pickup-grid");
  const picks = [];
  const nico = DATA.niconico || {};
  const yt = DATA.youtube || {};

  // ニコニコ新着の上位
  (nico.recent || []).slice(0, 6).forEach((x) => picks.push(x));
  // YouTube新着の上位
  (yt.recent || []).slice(0, 6).forEach((x) => picks.push(x));
  // 投稿日時順に並べ替え
  picks.sort((a, b) => new Date(b.posted_at) - new Date(a.posted_at));

  renderGrid(grid, picks.slice(0, 12), { emptyMsg: "新着トピックがまだありません。" });
}

function renderNiconico() {
  const nico = DATA.niconico || {};
  const years = nico.years || {};
  const tabsEl = document.getElementById("year-tabs");
  const grid = document.getElementById("niconico-grid");
  const yearKeys = Object.keys(years).sort((a, b) => b - a); // 新しい年が左

  tabsEl.innerHTML = "";
  if (!yearKeys.length) {
    grid.innerHTML = `<p class="empty">ニコニコのデータがありません。</p>`;
    return;
  }

  // 「新着」タブ + 各年タブ
  const allTabs = ["新着", ...yearKeys];
  allTabs.forEach((key, idx) => {
    const btn = el(`<button class="year-tab">${key === "新着" ? "🆕 新着" : key + "年"}</button>`);
    if (idx === 0) btn.classList.add("active");
    btn.addEventListener("click", () => {
      tabsEl.querySelectorAll(".year-tab").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      if (key === "新着") {
        renderGrid(grid, nico.recent || [], { emptyMsg: "新着がありません。" });
      } else {
        renderGrid(grid, years[key] || [], { ranked: true });
      }
    });
    tabsEl.appendChild(btn);
  });

  // 初期表示: 新着
  renderGrid(grid, nico.recent || [], { emptyMsg: "新着がありません。" });
}

function renderYoutube() {
  const yt = DATA.youtube || {};
  const grid = document.getElementById("youtube-grid");
  const subtabs = document.getElementById("yt-subtabs");

  const show = (mode) =>
    renderGrid(grid, (mode === "popular" ? yt.popular : yt.recent) || [], {
      emptyMsg: yt.enabled
        ? "該当する動画が見つかりませんでした。"
        : "YouTube連携は準備中です（APIキー設定後に表示されます）。",
    });

  subtabs.querySelectorAll(".subtab").forEach((b) => {
    b.addEventListener("click", () => {
      subtabs.querySelectorAll(".subtab").forEach((x) => x.classList.remove("active"));
      b.classList.add("active");
      show(b.dataset.yt);
    });
  });
  show("recent");
}

function renderTwitter() {
  const tw = DATA.twitter || {};
  const box = document.getElementById("twitter-notice");
  box.innerHTML = `
    <h3>Twitter (X) の取り込みは準備中</h3>
    <p>X の公式APIが有料化したため、現在は自動取得を行っていません。
       下のボタンから最新の「棒バト」関連ツイートを検索できます。</p>
    <a class="btn" href="${escapeHtml(tw.search_url || "https://twitter.com/search?q=" + encodeURIComponent("棒バト OR 棒人間バトル") + "&f=live")}" target="_blank" rel="noopener">
      🔍 Twitterで「${escapeHtml(tw.query || "棒バト")}」を検索
    </a>
  `;
}

async function init() {
  try {
    const res = await fetch("data/topics.json?v=" + Date.now());
    DATA = await res.json();
  } catch (e) {
    document.getElementById("updated").textContent = "データの読み込みに失敗しました";
    console.error(e);
    return;
  }

  const upd = document.getElementById("updated");
  upd.textContent = "最終更新: " + (DATA.updated_at ? fmtDate(DATA.updated_at) + " " + new Date(DATA.updated_at).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" }) : "不明");

  renderPickup();
  renderNiconico();
  renderYoutube();
  renderTwitter();
}

init();
