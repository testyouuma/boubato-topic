/* しんちょくノート — タスクの期限・進捗とルーティンを管理する Web アプリ
 * データは端末内（localStorage）に保存。通知は iPhone 標準のカレンダーに任せる。 */
(() => {
  "use strict";

  const STORE_KEY = "shinchoku-note-v1";
  const WD = ["日", "月", "火", "水", "木", "金", "土"];
  const ICS_DAY = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
  const REMIND_OPTS = [
    [-1, "通知しない"],
    [0, "期限の時刻"],
    [10, "期限の時刻＋10分前"],
    [30, "期限の時刻＋30分前"],
    [60, "期限の時刻＋1時間前"],
    [180, "期限の時刻＋3時間前"],
    [1440, "期限の時刻＋1日前"],
    [10080, "期限の時刻＋1週間前"],
  ];
  const LONG_COLORS = ["#4f6bed", "#e0772b", "#1f9d6b", "#b04fd6", "#d6384b", "#0f8fb3"];

  /* ---------- 状態と保存 ---------- */
  let state = load();
  let tab = "today";
  let taskFilter = "open";
  let calMonth = firstOfMonth(new Date());
  let calSelected = ymd(new Date());
  let schedDate = ymd(new Date());
  let suggestion = null; // { date, blocks } まだ決定していないTodo提案
  const autoOff = new Set(); // 自動提案を「やめる」した日

  function load() {
    let d = { tasks: [], routines: [] };
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (raw) d = JSON.parse(raw);
    } catch (e) { /* 壊れていたら空から */ }
    return migrate(d);
  }
  // 古い形式のデータを最新の形にそろえる
  function migrate(d) {
    const tasks = (d.tasks || []).map((t) => ({ kind: "normal", steps: [], start: "", ...t }));
    const routines = (d.routines || []).map((r) => ({ end: addMinutes(r.time || "07:00", 30), doneDates: [], ...r }));
    const events = d.events || [];
    // 60日より前の日のスケジュールは消して軽く保つ
    const cutoff = ymd(addDays(new Date(), -60));
    const plans = {};
    Object.entries(d.plans || {}).forEach(([k, v]) => { if (k >= cutoff && v.length) plans[k] = v; });
    const settings = { wake: "07:00", sleep: "23:00", theme: "auto", look: "memo", ...(d.settings || {}) };
    return { tasks, routines, events, plans, settings };
  }
  function save() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); }
    catch (e) { toast("保存できませんでした（プライベートブラウズ中かも）"); }
  }
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

  /* ---------- 日付ユーティリティ ---------- */
  function pad(n) { return String(n).padStart(2, "0"); }
  function ymd(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
  function firstOfMonth(d) { return new Date(d.getFullYear(), d.getMonth(), 1); }
  const hm = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const todayStr = () => ymd(new Date());
  const parseLocal = (s) => (s ? new Date(s) : null); // "YYYY-MM-DDTHH:MM" はローカル時刻
  const parseDay = (s) => (s ? new Date(`${s}T00:00`) : null);
  function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
  const startOfDay = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
  const mdw = (d) => `${d.getMonth() + 1}/${d.getDate()}(${WD[d.getDay()]})`;
  function addMinutes(time, m) {
    const [H, M] = time.split(":").map(Number);
    const t = (((H * 60 + M + m) % 1440) + 1440) % 1440;
    return `${pad(Math.floor(t / 60))}:${pad(t % 60)}`;
  }
  const toMin = (time) => { const [H, M] = time.split(":").map(Number); return H * 60 + M; };

  function fmtDue(d) {
    const now = new Date();
    const diffDay = Math.round((startOfDay(d) - startOfDay(now)) / 86400000);
    let day;
    if (diffDay === 0) day = "今日";
    else if (diffDay === 1) day = "明日";
    else if (diffDay === -1) day = "昨日";
    else day = mdw(d);
    if (d.getFullYear() !== now.getFullYear() && Math.abs(diffDay) > 1) day = `${d.getFullYear()}/` + day;
    return `${day} ${hm(d)}`;
  }
  function remaining(d) {
    const ms = d - Date.now();
    const a = Math.abs(ms);
    const min = Math.floor(a / 60000), h = Math.floor(a / 3600000), day = Math.floor(a / 86400000);
    const span = day >= 1 ? `${day}日` : h >= 1 ? `${h}時間` : `${Math.max(min, 1)}分`;
    if (ms < 0) return { text: `${span}超過`, cls: "danger" };
    if (ms < 86400000) return { text: `あと${span}`, cls: "warn" };
    return { text: `あと${span}`, cls: "" };
  }

  /* ---------- タスク ---------- */
  const isLong = (t) => t.kind === "long";
  function progressOf(t) {
    if (t.done) return 100;
    if (isLong(t) && t.steps.length) return Math.round((t.steps.filter((s) => s.done).length / t.steps.length) * 100);
    return t.progress;
  }
  // 長期タスクの「予定どおりなら今ごろ何％か」と、それに対するペース
  function pace(t) {
    if (!isLong(t) || !t.start || !t.due || t.done) return null;
    const s = parseDay(t.start), e = parseLocal(t.due), now = new Date();
    if (now < s) return { expected: 0, label: "開始前", cls: "" };
    const expected = Math.min(100, Math.max(0, Math.round(((now - s) / Math.max(e - s, 1)) * 100)));
    const diff = progressOf(t) - expected;
    if (diff >= -5) return { expected, label: diff >= 15 ? "前倒し" : "順調", cls: "ok" };
    if (diff >= -20) return { expected, label: "やや遅れ", cls: "warn" };
    return { expected, label: "遅れ", cls: "danger" };
  }
  function longColor(t) {
    let h = 0;
    for (const c of t.id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    return LONG_COLORS[h % LONG_COLORS.length];
  }
  // 長期タスクがその日に「期間中」か
  function longCovers(t, ds) {
    if (!isLong(t) || !t.due) return false;
    const s = t.start || t.due.slice(0, 10);
    return ds >= s && ds <= t.due.slice(0, 10);
  }

  /* ---------- ルーティン ---------- */
  const isScheduled = (r, d) => r.days.includes(d.getDay());
  const isDoneOn = (r, ds) => (r.doneDates || []).includes(ds);
  const timeRange = (r) => `${r.time}〜${r.end}`;
  function durationLabel(r) {
    let m = toMin(r.end) - toMin(r.time);
    if (m <= 0) m += 1440;
    return m >= 60 ? `${Math.floor(m / 60)}時間${m % 60 ? (m % 60) + "分" : ""}` : `${m}分`;
  }
  function streak(r) {
    let d = new Date();
    if (!isDoneOn(r, ymd(d))) d = addDays(d, -1); // 今日まだなら昨日から数える
    let n = 0;
    for (let i = 0; i < 400; i++) {
      if (isScheduled(r, d)) {
        if (isDoneOn(r, ymd(d))) n++;
        else break;
      }
      d = addDays(d, -1);
    }
    return n;
  }
  function daysLabel(days) {
    const s = [...days].sort().join("");
    if (s === "0123456") return "毎日";
    if (s === "12345") return "平日";
    if (s === "06") return "週末";
    return [1, 2, 3, 4, 5, 6, 0].filter((x) => days.includes(x)).map((x) => WD[x]).join("・");
  }
  function nextOccurrence(r, from = new Date()) {
    const [H, M] = r.time.split(":").map(Number);
    for (let i = 0; i < 8; i++) {
      const d = addDays(from, i);
      d.setHours(H, M, 0, 0);
      if (isScheduled(r, d) && d >= from) return d;
    }
    return null;
  }

  /* ---------- カレンダー(.ics) 生成 ---------- */
  const icsEsc = (s) => String(s || "").replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
  const icsLocal = (d) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}T${pad(d.getHours())}${pad(d.getMinutes())}00`;
  // 時刻には必ずタイムゾーン（日本なら Asia/Tokyo）を付ける。付けないと iPhone が別の時間帯として読むことがある
  const TZ = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Tokyo"; } catch (e) { return "Asia/Tokyo"; } })();
  const dt = (name, d) => `${name};TZID=${TZ}:${icsLocal(d)}`;
  function vtimezone() {
    const off = -new Date().getTimezoneOffset();
    const o = `${off >= 0 ? "+" : "-"}${pad(Math.floor(Math.abs(off) / 60))}${pad(Math.abs(off) % 60)}`;
    return ["BEGIN:VTIMEZONE", `TZID:${TZ}`, "BEGIN:STANDARD", "DTSTART:19700101T000000",
      `TZOFFSETFROM:${o}`, `TZOFFSETTO:${o}`, `TZNAME:${TZ === "Asia/Tokyo" ? "JST" : "UTC" + o}`, "END:STANDARD", "END:VTIMEZONE"];
  }
  const icsUtc = (d) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  function fold(line) {
    // 75オクテットごとに折り返す（UTF-8 の文字を途中で切らない）
    const enc = new TextEncoder();
    const out = [];
    let cur = "", bytes = 0;
    for (const ch of line) {
      const b = enc.encode(ch).length;
      if (bytes + b > 75) { out.push(cur); cur = " "; bytes = 1; }
      cur += ch; bytes += b;
    }
    out.push(cur);
    return out.join("\r\n");
  }
  function alarm(desc, minutesBefore) {
    return ["BEGIN:VALARM", "ACTION:DISPLAY", `DESCRIPTION:${icsEsc(desc)}`,
      `TRIGGER:${minutesBefore > 0 ? `-PT${minutesBefore}M` : "PT0M"}`, "END:VALARM"];
  }
  function taskEvent(t) {
    const due = parseLocal(t.due);
    const end = new Date(due.getTime() + 30 * 60000);
    const lines = ["BEGIN:VEVENT", `UID:task-${t.id}@shinchoku-note`, `DTSTAMP:${icsUtc(new Date())}`,
      dt("DTSTART", due), dt("DTEND", end),
      `SUMMARY:${icsEsc((isLong(t) ? "【長期・期限】" : "【期限】") + t.title)}`];
    const desc = [t.memo, ...(t.steps || []).map((s) => `・${s.title}`)].filter(Boolean).join("\n");
    if (desc) lines.push(`DESCRIPTION:${icsEsc(desc)}`);
    if (t.remind >= 0) {
      lines.push(...alarm(`期限です：${t.title}`, 0));
      if (t.remind > 0) lines.push(...alarm(`もうすぐ期限：${t.title}`, t.remind));
    }
    lines.push("END:VEVENT");
    return lines;
  }
  function routineEvent(r) {
    const start = nextOccurrence(r, startOfDay(new Date()));
    let mins = toMin(r.end) - toMin(r.time);
    if (mins <= 0) mins += 1440;
    const end = new Date(start.getTime() + mins * 60000);
    const rrule = r.days.length === 7 ? "RRULE:FREQ=DAILY"
      : `RRULE:FREQ=WEEKLY;BYDAY=${r.days.map((d) => ICS_DAY[d]).join(",")}`;
    return ["BEGIN:VEVENT", `UID:routine-${r.id}@shinchoku-note`, `DTSTAMP:${icsUtc(new Date())}`,
      dt("DTSTART", start), dt("DTEND", end), rrule,
      `SUMMARY:${icsEsc("🔁 " + r.title)}`, ...alarm(`ルーティンの時間です：${r.title}（〜${r.end}）`, 0), "END:VEVENT"];
  }
  function buildIcs(eventLines) {
    const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//ShinchokuNote//JA", "CALSCALE:GREGORIAN",
      "METHOD:PUBLISH", ...vtimezone(), ...eventLines, "END:VCALENDAR"];
    return lines.map(fold).join("\r\n") + "\r\n";
  }
  function openIcs(text, name) {
    const blob = new Blob([text], { type: "text/calendar;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    // iPhone では download 属性を付けないと「カレンダーに追加」画面が開く
    const ua = navigator.userAgent;
    const appleTouch = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && "ontouchend" in document);
    if (!appleTouch) a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  /* ---------- 画面描画 ---------- */
  const $ = (s, el = document) => el.querySelector(s);
  const main = $("#main");
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const CHECK_SVG = '<svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const TITLES_EN = { today: "TODAY", schedule: "SCHEDULE", tasks: "TASKS", calendar: "CALENDAR", routines: "ROUTINES" };
  const TITLES = { today: "今日", schedule: "スケジュール", tasks: "タスク", calendar: "カレンダー", routines: "ルーティン" };

  function render() {
    $("#screen-title").textContent = TITLES[tab];
    $("#screen-title").dataset.en = TITLES_EN[tab];
    document.querySelectorAll(".tabs button").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
    ({ today: renderToday, schedule: renderSchedule, tasks: renderTasks, calendar: renderCalendar, routines: renderRoutines })[tab]();
  }

  function progressBar(t) {
    const p = progressOf(t);
    const pc = pace(t);
    const marker = pc && pc.expected > 0 && pc.expected < 100
      ? `<b class="pace-mark" style="left:${pc.expected}%" title="予定ペース"></b>` : "";
    return `<div class="bar-row"><div class="bar ${p >= 100 ? "full" : ""}"><i style="width:${p}%"></i>${marker}</div><span>${p}%</span></div>`;
  }

  function taskCard(t) {
    const long = isLong(t);
    let meta = "";
    if (long) meta += `<span class="badge long" style="--c:${longColor(t)}">長期</span>`;
    if (long && t.start && t.due) meta += `<span>🗓 ${mdw(parseDay(t.start))}〜${mdw(parseLocal(t.due))}</span>`;
    else if (t.due) meta += `<span>📅 ${fmtDue(parseLocal(t.due))}</span>`;
    else meta += `<span>期限なし</span>`;
    if (t.due && !t.done) { const r = remaining(parseLocal(t.due)); meta += `<span class="badge ${r.cls}">${r.text}</span>`; }
    if (t.done) meta += `<span class="badge ok">完了</span>`;
    const pc = pace(t);
    if (pc) meta += `<span class="badge ${pc.cls}">${pc.label}</span>`;
    if (long && t.steps.length) meta += `<span>ステップ ${t.steps.filter((s) => s.done).length}/${t.steps.length}</span>`;
    if (!t.done && t.calAdded && t.due && t.remind >= 0) meta += `<span class="badge bell">🔔通知</span>`;
    let next = "";
    if (long && !t.done) {
      const s = t.steps.find((x) => !x.done);
      if (s) next = `<div class="next-step">次：${esc(s.title)}</div>`;
    }
    return `<div class="card ${t.done ? "done" : ""} ${long ? "long" : ""}" data-task="${t.id}" ${long ? `style="--c:${longColor(t)}"` : ""}>
      <button class="check ${t.done ? "on" : ""}" data-toggle-task="${t.id}" aria-label="完了にする">${CHECK_SVG}</button>
      <div class="body"><div class="title">${esc(t.title)}</div><div class="meta">${meta}</div>${t.done ? "" : progressBar(t)}${next}</div></div>`;
  }

  function routineCard(r, ds, checkable) {
    const done = isDoneOn(r, ds);
    const s = streak(r);
    const meta = `<span>⏰ ${timeRange(r)}</span><span>${daysLabel(r.days)}</span>` +
      (s > 0 ? `<span class="badge ok">🔥 ${s}回連続</span>` : "") +
      (r.calAdded ? `<span class="badge bell">🔔通知</span>` : "");
    const check = checkable
      ? `<button class="check ${done ? "on" : ""}" data-toggle-routine="${r.id}" data-date="${ds}" aria-label="やった">${CHECK_SVG}</button>`
      : `<div class="check ghost" aria-hidden="true"></div>`;
    return `<div class="card ${checkable && done ? "done" : ""}" data-routine="${r.id}">${check}
      <div class="body"><div class="title">${esc(r.title)}</div><div class="meta">${meta}</div></div></div>`;
  }

  function renderToday() {
    const now = new Date();
    const ts = ymd(now);
    const todays = state.routines.filter((r) => isScheduled(r, now)).sort((a, b) => a.time.localeCompare(b.time));
    const rDone = todays.filter((r) => isDoneOn(r, ts)).length;
    const open = state.tasks.filter((t) => !t.done);
    const endToday = addDays(startOfDay(now), 1);
    const overdue = open.filter((t) => t.due && parseLocal(t.due) < now);
    const dueToday = open.filter((t) => t.due && parseLocal(t.due) >= now && parseLocal(t.due) < endToday);
    const soonLimit = addDays(startOfDay(now), 4);
    const soon = open.filter((t) => t.due && parseLocal(t.due) < soonLimit).sort((a, b) => a.due.localeCompare(b.due));
    const longs = open.filter((t) => isLong(t) && !soon.includes(t) && (!t.start || t.start <= ts))
      .sort((a, b) => (a.due || "9").localeCompare(b.due || "9"));
    const doneToday = state.tasks.filter((t) => t.done && t.doneAt && ymd(new Date(t.doneAt)) === ts);

    const total = todays.length + overdue.length + dueToday.length + doneToday.length;
    const got = rDone + doneToday.length;
    const pct = total ? Math.round((got / total) * 100) : 0;
    const C = 2 * Math.PI * 36;
    const nowMin = now.getHours() * 60 + now.getMinutes();
    const dayList = dayItems(ts).filter((i) => !i.done);
    const current = dayList.find((i) => nowMin >= i.s && nowMin < i.e);
    const next = dayList.find((i) => i.s > nowMin);
    const kindLabel = { event: "予定", routine: "ルーティン", plan: "Todo" };
    const nowCard = (current || next) ? `<button class="now-banner" data-goto="schedule">
        ${current ? `<span>▶ いま：${esc(current.title)}（〜${current.end}）</span>` : ""}
        ${next ? `<span class="next">次：${next.start} ${esc(next.title)} <small>${kindLabel[next.kind]}</small></span>` : ""}
        <small class="go">スケジュールを見る ›</small></button>`
      : `<button class="now-banner" data-goto="schedule"><span>このあとの予定はありません</span><small class="go">💡 Todoを提案してもらう ›</small></button>`;

    main.innerHTML = `
      <section class="summary">
        <div class="date">${now.getMonth() + 1}月${now.getDate()}日（${WD[now.getDay()]}）</div>
        <div class="ring-row">
          <div class="ring"><svg viewBox="0 0 84 84"><circle class="bg" cx="42" cy="42" r="36"/>
            <circle class="fg" ${pct ? "" : 'opacity="0"'} cx="42" cy="42" r="36" stroke-dasharray="${C}" stroke-dashoffset="${C * (1 - pct / 100)}"/></svg>
            <div class="pct">${total ? pct + "%" : "—"}</div></div>
          <div class="ring-text">
            <span>今日の達成</span>
            <b>${total ? `${got} / ${total} 件` : "予定はありません"}</b>
            <span>ルーティン ${rDone}/${todays.length}・タスク完了 ${doneToday.length}</span>
          </div>
        </div>
        <div class="stats">
          <div class="stat ${overdue.length ? "danger" : ""}"><div class="n">${overdue.length}</div><div class="l">期限切れ</div></div>
          <div class="stat ${dueToday.length ? "warn" : ""}"><div class="n">${dueToday.length}</div><div class="l">今日が期限</div></div>
          <div class="stat"><div class="n">${open.length}</div><div class="l">未完了タスク</div></div>
        </div>
        ${nowCard}
      </section>

      <div class="section-title">今日のルーティン <small>${rDone}/${todays.length}</small></div>
      <div class="list">${todays.length ? todays.map((r) => routineCard(r, ts, true)).join("")
        : `<div class="empty">今日のルーティンはありません<br>「ルーティン」タブから登録できます</div>`}</div>

      <div class="section-title">期限が近いタスク <small>3日以内・期限切れ</small></div>
      <div class="list">${soon.length ? soon.map(taskCard).join("")
        : `<div class="empty">期限が近いタスクはありません 🎉</div>`}</div>

      ${longs.length ? `<div class="section-title">進行中の長期タスク <small>${longs.length}件</small></div>
      <div class="list">${longs.map(taskCard).join("")}</div>` : ""}`;
  }

  function renderTasks() {
    const all = state.tasks;
    const doneN = all.filter((t) => t.done).length;
    const avg = all.length ? Math.round(all.reduce((s, t) => s + progressOf(t), 0) / all.length) : 0;
    const longN = all.filter((t) => isLong(t) && !t.done).length;
    let list = all.filter((t) => (taskFilter === "open" ? !t.done : taskFilter === "done" ? t.done
      : taskFilter === "long" ? isLong(t) && !t.done : true));
    list.sort((a, b) => {
      if (a.done !== b.done) return a.done ? 1 : -1;
      if (a.done) return (b.doneAt || 0) - (a.doneAt || 0);
      if (!a.due !== !b.due) return a.due ? -1 : 1;
      return (a.due || "").localeCompare(b.due || "") || a.createdAt - b.createdAt;
    });
    const chip = (k, label) => `<button class="chip ${taskFilter === k ? "on" : ""}" data-filter="${k}">${label}</button>`;
    main.innerHTML = `
      <section class="summary">
        <div class="ring-text"><span>全体の進捗</span><b>${doneN} / ${all.length} 件完了・平均 ${avg}%</b></div>
        <div class="bar ${avg >= 100 ? "full" : ""}" style="height:10px"><i style="width:${avg}%"></i></div>
      </section>
      <div class="section-title" style="margin-top:16px"><div class="chips">${chip("open", `未完了 ${all.length - doneN}`)}${chip("long", `長期 ${longN}`)}${chip("done", `完了 ${doneN}`)}${chip("all", "すべて")}</div></div>
      <div class="list">${list.length ? list.map(taskCard).join("")
        : `<div class="empty">${taskFilter === "done" ? "完了したタスクはまだありません"
          : taskFilter === "long" ? "長期タスクはありません<br>＋ →「長期」で、開始日〜期限とステップを決めて登録できます"
          : "タスクはありません<br>右下の ＋ から追加しましょう"}</div>`}</div>`;
  }

  function renderRoutines() {
    const now = new Date();
    const ts = ymd(now);
    const list = [...state.routines].sort((a, b) => a.time.localeCompare(b.time));
    main.innerHTML = `
      <p class="note" style="margin:4px 4px 12px">決まった曜日・時間帯にくり返す習慣です。今日が対象日のものはチェックできます。</p>
      <div class="list">${list.length ? list.map((r) => routineCard(r, ts, isScheduled(r, now))).join("")
        : `<div class="empty">ルーティンはまだありません<br>右下の ＋ から追加しましょう<br><small>例：朝の筋トレ 7:00〜7:30・日記・薬を飲む</small></div>`}</div>`;
  }

  /* ---------- カレンダー画面 ---------- */
  function renderCalendar() {
    const y = calMonth.getFullYear(), m = calMonth.getMonth();
    const first = new Date(y, m, 1);
    const gridStart = addDays(first, -first.getDay());
    const weeks = Math.ceil((first.getDay() + new Date(y, m + 1, 0).getDate()) / 7);
    const ts = todayStr();
    const now = new Date();
    const longs = state.tasks.filter((t) => isLong(t) && t.due);

    let cells = "";
    for (let i = 0; i < weeks * 7; i++) {
      const d = addDays(gridStart, i);
      const ds = ymd(d);
      // マスの中に名前をそのまま並べる（長期タスク → 予定 → 期限のタスク）
      const bars = longs.filter((t) => longCovers(t, ds)).map((t) => {
        const st = (t.start || t.due.slice(0, 10)) === ds || d.getDay() === 0 || ds === ymd(gridStart);
        const en = t.due.slice(0, 10) === ds || d.getDay() === 6;
        return `<i class="cl long ${st ? "s" : "cont"} ${en ? "e" : ""} ${t.done ? "done" : ""}" style="--c:${longColor(t)}">${st ? esc(t.title) : ""}</i>`;
      }).join("");
      const evs = eventsOn(ds).map((ev) => `<i class="cl ev">${esc(ev.title)}</i>`).join("");
      const dues = state.tasks.filter((t) => !isLong(t) && t.due && t.due.slice(0, 10) === ds)
        .sort((x, y) => x.due.localeCompare(y.due))
        .map((t) => `<i class="cl task ${t.done ? "done" : parseLocal(t.due) < now ? "over" : ""}">${esc(t.title)}</i>`).join("");
      const sched = state.routines.filter((r) => isScheduled(r, d));
      const allDone = sched.length && ds <= ts && sched.every((r) => isDoneOn(r, ds));
      const cls = [d.getMonth() !== m ? "out" : "", ds === ts ? "today" : "", ds === calSelected ? "sel" : "",
        d.getDay() === 0 ? "sun" : d.getDay() === 6 ? "sat" : ""].join(" ");
      cells += `<button class="cal-cell ${cls}" data-day="${ds}">
        <span class="num">${d.getDate()}${allDone ? '<em class="rdone">✓</em>' : ""}</span>
        <span class="items">${bars}${evs}${dues}</span></button>`;
    }

    main.innerHTML = `
      <section class="cal">
        <div class="cal-head">
          <button class="icon-btn sm" data-cal-move="-1" aria-label="前の月">‹</button>
          <b>${y}年${m + 1}月</b>
          <button class="icon-btn sm" data-cal-move="1" aria-label="次の月">›</button>
        </div>
        <div class="cal-grid wd">${WD.map((w, i) => `<span class="${i === 0 ? "sun" : i === 6 ? "sat" : ""}">${w}</span>`).join("")}</div>
        <div class="cal-grid">${cells}</div>
        <div class="cal-legend"><span><i class="lg ev"></i>予定</span><span><i class="lg task"></i>タスクの期限</span><span><i class="lg over"></i>期限切れ</span><span><i class="lg long"></i>長期タスクの期間</span><span><em class="rdone">✓</em>ルーティン全部できた</span></div>
        ${calMonth.getTime() !== firstOfMonth(now).getTime() ? `<button class="text-btn" data-cal-today style="justify-self:center">今日に戻る</button>` : ""}
      </section>
      ${dayAgenda(calSelected)}`;
  }

  function dayAgenda(ds) {
    const d = parseDay(ds);
    const ts = todayStr();
    const routines = state.routines.filter((r) => isScheduled(r, d)).sort((a, b) => a.time.localeCompare(b.time));
    const dues = state.tasks.filter((t) => t.due && t.due.slice(0, 10) === ds).sort((a, b) => a.due.localeCompare(b.due));
    const ongoing = state.tasks.filter((t) => longCovers(t, ds) && !dues.includes(t));
    const evs = eventsOn(ds);
    const planN = (state.plans[ds] || []).length;
    const empty = !routines.length && !dues.length && !ongoing.length && !evs.length;
    return `
      <div class="section-title">${d.getMonth() + 1}月${d.getDate()}日（${WD[d.getDay()]}）${ds === ts ? " ・今日" : ""}</div>
      <div class="agenda-actions">
        <button class="chip" data-add-event="${ds}">＋ 予定</button><button class="chip" data-add-on="${ds}">＋ タスク</button>
        <button class="chip on" data-open-schedule="${ds}">🗓 スケジュール表${planN ? `（Todo ${planN}）` : ""}</button>
      </div>
      ${empty ? `<div class="empty">予定はありません</div>` : ""}
      ${evs.length ? `<div class="sub-title">予定</div><div class="list">${evs.map((ev) => eventCard(ev)).join("")}</div>` : ""}
      ${routines.length ? `<div class="sub-title">ルーティン</div><div class="list">${routines.map((r) => routineCard(r, ds, ds <= ts)).join("")}</div>` : ""}
      ${dues.length ? `<div class="sub-title">この日が期限</div><div class="list">${dues.map(taskCard).join("")}</div>` : ""}
      ${ongoing.length ? `<div class="sub-title">期間中の長期タスク</div><div class="list">${ongoing.map(taskCard).join("")}</div>` : ""}`;
  }

  /* ---------- 編集シート ---------- */
  const sheet = $("#sheet");
  const form = $("#sheet-form");
  function openSheet(html, bind) {
    form.innerHTML = `<div class="grab"></div>${html}`;
    form.onsubmit = null;
    bind && bind(form);
    if (!sheet.open) sheet.showModal();
    sheet.scrollTop = 0;
  }
  function closeSheet() { sheet.close(); }
  sheet.addEventListener("click", (e) => { if (e.target === sheet) closeSheet(); });

  function taskSheet(t, presetDate) {
    const isNew = !t;
    t = t || { id: uid(), kind: "normal", title: "", memo: "", start: "", due: presetDate ? `${presetDate}T18:00` : "",
      remind: 0, progress: 0, steps: [], done: false, createdAt: Date.now(), calAdded: false };
    let kind = t.kind;
    let steps = t.steps.map((s) => ({ ...s }));
    const dueD = parseLocal(t.due);
    const opts = REMIND_OPTS.map(([v, l]) => `<option value="${v}" ${t.remind === v ? "selected" : ""}>${l}</option>`).join("");
    openSheet(`
      <h2>${isNew ? "タスクを追加" : "タスクを編集"}</h2>
      <div class="seg" role="tablist">
        <button type="button" data-kind="normal">ふつう</button>
        <button type="button" data-kind="long">長期（期間＋ステップ）</button>
      </div>
      <div class="field"><label for="f-title">やること</label>
        <input type="text" id="f-title" value="${esc(t.title)}" placeholder="例：レポートを提出する" autocomplete="off" required></div>
      <div class="field long-only"><label for="f-start">開始日</label><input type="date" id="f-start" value="${esc(t.start)}"></div>
      <div class="field"><span class="label">期限（いつまでに完了）</span>
        <div class="row2"><input type="date" id="f-date" value="${dueD ? ymd(dueD) : ""}"><input type="time" id="f-time" value="${dueD ? hm(dueD) : ""}"></div>
        <div class="quick normal-only">
          <button type="button" class="chip" data-q="0">今日</button><button type="button" class="chip" data-q="1">明日</button>
          <button type="button" class="chip" data-q="7">1週間後</button><button type="button" class="chip" data-q="x">期限なし</button>
        </div>
        <div class="quick long-only">
          <button type="button" class="chip" data-q="14">2週間後</button><button type="button" class="chip" data-q="30">1か月後</button>
          <button type="button" class="chip" data-q="90">3か月後</button><button type="button" class="chip" data-q="180">半年後</button>
        </div></div>
      <div class="field long-only"><span class="label">ステップ（チェックすると進捗が自動で上がります）</span>
        <div id="f-steps" class="steps"></div>
        <div class="step-add"><input type="text" id="f-step-new" placeholder="例：資料を集める" autocomplete="off"><button type="button" class="btn" id="f-step-btn">追加</button></div>
      </div>
      <div class="field" id="f-progress-field"><label for="f-progress">進捗 <b id="f-pv">${t.progress}%</b></label>
        <input type="range" id="f-progress" min="0" max="100" step="5" value="${t.progress}"></div>
      <div class="field"><label for="f-est" id="f-est-label">かかる時間の目安（Todo提案で使います）</label><select id="f-est">${EST_OPTS.map((v) => `<option value="${v}" ${(t.est || 60) === v ? "selected" : ""}>${durText(v)}</option>`).join("")}</select></div>
      <div class="field"><label for="f-remind">通知</label><select id="f-remind">${opts}</select></div>
      <div class="field"><label for="f-memo">メモ</label><textarea id="f-memo" placeholder="任意">${esc(t.memo)}</textarea></div>
      <div class="actions">
        ${isNew ? "" : `<button type="button" class="btn danger" id="f-del">削除</button>`}
        <button type="button" class="btn" id="f-cancel">キャンセル</button>
        <button type="submit" class="btn primary" id="f-save">保存</button>
      </div>`,
    (f) => {
      const date = $("#f-date", f), time = $("#f-time", f), startI = $("#f-start", f);
      const paintKind = () => {
        f.querySelectorAll("[data-kind]").forEach((b) => b.classList.toggle("on", b.dataset.kind === kind));
        f.querySelectorAll(".long-only").forEach((el) => (el.hidden = kind !== "long"));
        f.querySelectorAll(".normal-only").forEach((el) => (el.hidden = kind === "long"));
        $("#f-progress-field", f).hidden = kind === "long" && steps.length > 0;
        $("#f-title", f).placeholder = kind === "long" ? "例：資格試験に合格する" : "例：レポートを提出する";
        $("#f-est-label", f).textContent = kind === "long" ? "1回あたりの作業時間（Todo提案で使います）" : "かかる時間の目安（Todo提案で使います）";
        if (kind === "long" && !startI.value) startI.value = todayStr();
      };
      const paintSteps = () => {
        $("#f-steps", f).innerHTML = steps.length ? steps.map((s, i) => `
          <div class="step ${s.done ? "done" : ""}">
            <button type="button" class="check sm ${s.done ? "on" : ""}" data-step-toggle="${i}" aria-label="完了">${CHECK_SVG}</button>
            <input type="text" value="${esc(s.title)}" data-step-edit="${i}" aria-label="ステップ名">
            <button type="button" class="step-del" data-step-del="${i}" aria-label="削除">✕</button>
          </div>`).join("") : `<p class="note">まだステップがありません。大きな目標を小さな段階に分けてみましょう。</p>`;
        $("#f-progress-field", f).hidden = kind === "long" && steps.length > 0;
      };
      paintKind(); paintSteps();
      f.querySelectorAll("[data-kind]").forEach((b) => b.onclick = () => { kind = b.dataset.kind; paintKind(); });
      const addStep = () => {
        const inp = $("#f-step-new", f);
        const v = inp.value.trim();
        if (!v) return;
        steps.push({ id: uid(), title: v, done: false });
        inp.value = ""; paintSteps(); inp.focus();
      };
      $("#f-step-btn", f).onclick = addStep;
      $("#f-step-new", f).onkeydown = (e) => { if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); addStep(); } };
      $("#f-steps", f).addEventListener("click", (e) => {
        const tg = e.target.closest("[data-step-toggle]");
        if (tg) {
          const at = fx.point(e);
          const s = steps[Number(tg.dataset.stepToggle)]; s.done = !s.done; paintSteps();
          if (s.done) fx.burst(at[0], at[1]);
          return;
        }
        const dl = e.target.closest("[data-step-del]");
        if (dl) { steps.splice(Number(dl.dataset.stepDel), 1); paintSteps(); }
      });
      $("#f-steps", f).addEventListener("input", (e) => {
        const ed = e.target.closest("[data-step-edit]");
        if (ed) steps[Number(ed.dataset.stepEdit)].title = ed.value;
      });
      $("#f-progress", f).oninput = (e) => { $("#f-pv", f).textContent = e.target.value + "%"; };
      f.querySelectorAll("[data-q]").forEach((b) => b.onclick = () => {
        const q = b.dataset.q;
        if (q === "x") { date.value = ""; time.value = ""; return; }
        const base = kind === "long" && startI.value ? parseDay(startI.value) : new Date();
        date.value = ymd(addDays(base, Number(q)));
        if (!time.value) time.value = kind === "long" ? "23:59" : "18:00";
      });
      date.onchange = () => { if (date.value && !time.value) time.value = kind === "long" ? "23:59" : "18:00"; };
      $("#f-cancel", f).onclick = closeSheet;
      if (!isNew) $("#f-del", f).onclick = () => {
        if (!confirm(`「${t.title}」を削除しますか？` + (t.calAdded ? "\n※カレンダーに追加した予定は、カレンダーアプリから削除してください。" : ""))) return;
        state.tasks = state.tasks.filter((x) => x.id !== t.id); save(); closeSheet(); render();
      };
      f.onsubmit = (e) => {
        e.preventDefault();
        const title = $("#f-title", f).value.trim();
        if (!title) { $("#f-title", f).focus(); return; }
        const newDue = date.value ? `${date.value}T${time.value || "18:00"}` : "";
        if (kind === "long") {
          if (!newDue) { toast("長期タスクは期限を決めてください"); date.focus(); return; }
          if (startI.value && startI.value > date.value) { toast("開始日が期限より後になっています"); return; }
        }
        const pending = $("#f-step-new", f).value.trim();
        if (kind === "long" && pending) steps.push({ id: uid(), title: pending, done: false });
        const remind = Number($("#f-remind", f).value);
        const changedSchedule = newDue !== t.due || remind !== t.remind || title !== t.title;
        Object.assign(t, {
          kind, title, memo: $("#f-memo", f).value.trim(), due: newDue, remind,
          start: kind === "long" ? startI.value : "",
          steps: kind === "long" ? steps.filter((s) => s.title.trim()) : [],
          progress: Number($("#f-progress", f).value),
          est: Number($("#f-est", f).value),
        });
        if (progressOf({ ...t, done: false }) >= 100 && !t.done) { t.done = true; t.doneAt = Date.now(); }
        if (changedSchedule && !isNew) t.calAdded = false;
        if (isNew) state.tasks.push(t);
        save(); render();
        if (t.due && t.remind >= 0 && !t.done && !t.calAdded && parseLocal(t.due) > new Date()) {
          calPrompt(() => {
            openIcs(buildIcs(taskEvent(t)), `task-${t.id}.ics`);
            t.calAdded = true; save(); render();
          }, changedSchedule && !isNew);
        } else closeSheet();
      };
      setTimeout(() => { if (isNew) $("#f-title", f).focus(); }, 50);
    });
  }

  function routineSheet(r) {
    const isNew = !r;
    r = r || { id: uid(), title: "", time: "07:00", end: "07:30", days: [0, 1, 2, 3, 4, 5, 6], doneDates: [], calAdded: false };
    let days = [...r.days];
    const order = [1, 2, 3, 4, 5, 6, 0];
    openSheet(`
      <h2>${isNew ? "ルーティンを追加" : "ルーティンを編集"}</h2>
      <div class="field"><label for="r-title">内容</label>
        <input type="text" id="r-title" value="${esc(r.title)}" placeholder="例：朝のストレッチ" autocomplete="off" required></div>
      <div class="field"><span class="label">時間帯（開始の時刻に通知）</span>
        <div class="row2 time-range"><label class="mini">開始<input type="time" id="r-time" value="${r.time}" required></label>
          <label class="mini">終了<input type="time" id="r-end" value="${r.end}" required></label></div>
        <div class="quick"><button type="button" class="chip" data-len="15">15分</button><button type="button" class="chip" data-len="30">30分</button>
          <button type="button" class="chip" data-len="60">1時間</button><button type="button" class="chip" data-len="120">2時間</button></div>
        <p class="note" id="r-dur"></p></div>
      <div class="field"><span class="label">くり返す曜日</span>
        <div class="days">${order.map((d) => `<button type="button" class="day ${d === 0 ? "sun" : d === 6 ? "sat" : ""}" data-d="${d}">${WD[d]}</button>`).join("")}</div>
        <div class="quick"><button type="button" class="chip" data-p="all">毎日</button><button type="button" class="chip" data-p="wd">平日</button><button type="button" class="chip" data-p="we">週末</button></div></div>
      <div class="actions">
        ${isNew ? "" : `<button type="button" class="btn danger" id="r-del">削除</button>`}
        <button type="button" class="btn" id="r-cancel">キャンセル</button>
        <button type="submit" class="btn primary">保存</button>
      </div>`,
    (f) => {
      const tI = $("#r-time", f), eI = $("#r-end", f);
      let len = (toMin(r.end) - toMin(r.time) + 1440) % 1440 || 30;
      const showDur = () => {
        if (!tI.value || !eI.value) return;
        $("#r-dur", f).textContent = `${tI.value}〜${eI.value}（${durationLabel({ time: tI.value, end: eI.value })}）`
          + (toMin(eI.value) <= toMin(tI.value) ? " ・日をまたぎます" : "");
      };
      showDur();
      // 開始時刻を変えたら、長さを保ったまま終了時刻もずらす
      tI.onchange = () => { if (tI.value) eI.value = addMinutes(tI.value, len); showDur(); };
      eI.onchange = () => { if (tI.value && eI.value) len = (toMin(eI.value) - toMin(tI.value) + 1440) % 1440 || 1440; showDur(); };
      f.querySelectorAll("[data-len]").forEach((b) => b.onclick = () => {
        len = Number(b.dataset.len); eI.value = addMinutes(tI.value || "07:00", len); showDur();
      });
      const paint = () => f.querySelectorAll(".day").forEach((b) => b.classList.toggle("on", days.includes(Number(b.dataset.d))));
      paint();
      f.querySelectorAll(".day").forEach((b) => b.onclick = () => {
        const d = Number(b.dataset.d);
        days = days.includes(d) ? days.filter((x) => x !== d) : [...days, d];
        paint();
      });
      f.querySelectorAll("[data-p]").forEach((b) => b.onclick = () => {
        days = { all: [0, 1, 2, 3, 4, 5, 6], wd: [1, 2, 3, 4, 5], we: [0, 6] }[b.dataset.p]; paint();
      });
      $("#r-cancel", f).onclick = closeSheet;
      if (!isNew) $("#r-del", f).onclick = () => {
        if (!confirm(`「${r.title}」を削除しますか？` + (r.calAdded ? "\n※カレンダーの予定（くり返し）は、カレンダーアプリで「今後のすべてのイベントを削除」してください。" : ""))) return;
        state.routines = state.routines.filter((x) => x.id !== r.id); save(); closeSheet(); render();
      };
      f.onsubmit = (e) => {
        e.preventDefault();
        const title = $("#r-title", f).value.trim();
        if (!title) { $("#r-title", f).focus(); return; }
        if (!days.length) { toast("曜日を1つ以上選んでください"); return; }
        const time = tI.value || "07:00";
        const end = eI.value || addMinutes(time, 30);
        if (end === time) { toast("終了時刻を開始時刻と別にしてください"); return; }
        const changed = title !== r.title || time !== r.time || end !== r.end || [...days].sort().join() !== [...r.days].sort().join();
        Object.assign(r, { title, time, end, days: days.sort() });
        if (changed && !isNew) r.calAdded = false;
        if (isNew) state.routines.push(r);
        save(); render();
        if (!r.calAdded) {
          calPrompt(() => {
            openIcs(buildIcs(routineEvent(r)), `routine-${r.id}.ics`);
            r.calAdded = true; save(); render();
          }, changed && !isNew);
        } else closeSheet();
      };
      setTimeout(() => { if (isNew) $("#r-title", f).focus(); }, 50);
    });
  }

  function calPrompt(onAdd, wasChanged) {
    form.onsubmit = (e) => e.preventDefault();
    form.innerHTML = `<div class="grab"></div>
      <h2>🔔 通知を設定しますか？</h2>
      <p class="note" style="font-size:14px;color:var(--text)">iPhone の「カレンダー」に予定として追加すると、指定した時刻にカレンダーから通知が届きます。</p>
      ${wasChanged ? `<p class="note">※内容を変更したので、カレンダーにある古い予定は手動で削除してください。</p>` : ""}
      <p class="note">次の画面で右上の「追加」→「完了」をタップしてください。</p>
      <div class="actions"><button type="button" class="btn" id="c-skip">あとで</button>
        <button type="button" class="btn primary" id="c-add">カレンダーに追加</button></div>`;
    $("#c-skip", form).onclick = closeSheet;
    $("#c-add", form).onclick = () => { closeSheet(); onAdd(); };
  }

  function menuSheet() {
    const pendingTasks = state.tasks.filter((t) => !t.done && t.due && t.remind >= 0 && !t.calAdded && parseLocal(t.due) > new Date());
    const pendingRoutines = state.routines.filter((r) => !r.calAdded);
    const pendingEvents = state.events.filter((ev) => !ev.calAdded && ev.remind >= 0 && (ev.repeat === "weekly" || ev.date >= todayStr()));
    const n = pendingTasks.length + pendingRoutines.length + pendingEvents.length;
    openSheet(`
      <h2>メニュー</h2>
      <div class="field"><span class="label">見た目</span>
        <div class="seg seg4">
          <button type="button" data-look-set="memo">📒 メモ帳</button>
          <button type="button" data-look-set="modern">✨ モダン</button>
          <button type="button" data-look-set="cyber">🌐 サイバー</button>
          <button type="button" data-look-set="kotan">🍊 コタン</button>
        </div>
        <p class="note" id="m-look-note"></p></div>
      <div class="field"><span class="label">テーマ</span>
        <div class="seg seg3">
          <button type="button" data-theme-set="auto">📱 自動</button>
          <button type="button" data-theme-set="light">☀️ 白</button>
          <button type="button" data-theme-set="dark">🌙 黒</button>
        </div>
        <p class="note">「自動」は iPhone のダークモード設定に合わせます</p></div>
      <div class="field"><span class="label">1日の活動時間（Todo提案はこの間で考えます）</span>
        <div class="row2 time-range"><label class="mini">起きる<input type="time" id="m-wake" value="${state.settings.wake}"></label>
          <label class="mini">寝る<input type="time" id="m-sleep" value="${state.settings.sleep}"></label></div></div>
      <div class="menu-list">
        <button type="button" class="btn cal" id="m-cal" ${n ? "" : "disabled"}>🔔 未登録の通知をまとめてカレンダーに追加（${n}件）</button>
        <button type="button" class="btn" id="m-recal">🔁 カレンダーの通知をすべて登録し直す</button>
        <button type="button" class="btn" id="m-export">📤 バックアップを書き出す</button>
        <button type="button" class="btn" id="m-import">📥 バックアップから復元</button>
        <button type="button" class="btn" id="m-clear">🧹 完了したタスクを整理</button>
        <input type="file" id="m-file" accept="application/json,.json" hidden>
      </div>
      <p class="note">データはこの iPhone の中だけに保存されます。機種変更の前などにバックアップを書き出しておくと安心です。</p>
      <div class="actions"><button type="button" class="btn" id="m-close">閉じる</button></div>`,
    (f) => {
      f.onsubmit = (e) => e.preventDefault();
      $("#m-close", f).onclick = closeSheet;
      const paintTheme = () => f.querySelectorAll("[data-theme-set]").forEach((b) => b.classList.toggle("on", b.dataset.themeSet === state.settings.theme));
      paintTheme();
      const paintLook = () => {
        f.querySelectorAll("[data-look-set]").forEach((b) => b.classList.toggle("on", b.dataset.lookSet === state.settings.look));
        $("#m-look-note", f).textContent = state.settings.look === "cyber" ? "サイバーはいつも暗い配色です（テーマの白・黒は使われません）" : "";
      };
      paintLook();
      f.querySelectorAll("[data-look-set]").forEach((b) => b.onclick = () => {
        state.settings.look = b.dataset.lookSet; save(); applyTheme(); paintLook(); render(); fx.enter(); fx.glitch();
      });
      f.querySelectorAll("[data-theme-set]").forEach((b) => b.onclick = () => {
        state.settings.theme = b.dataset.themeSet; save(); applyTheme(); paintTheme();
      });
      const saveTimes = () => {
        state.settings.wake = $("#m-wake", f).value || "07:00";
        state.settings.sleep = $("#m-sleep", f).value || "23:00";
        save();
      };
      $("#m-wake", f).onchange = saveTimes;
      $("#m-sleep", f).onchange = saveTimes;
      $("#m-cal", f).onclick = () => {
        const ev = [...pendingTasks.flatMap(taskEvent), ...pendingRoutines.flatMap(routineEvent), ...pendingEvents.flatMap(eventEvent)];
        pendingEvents.forEach((x) => (x.calAdded = true));
        openIcs(buildIcs(ev), "shinchoku-all.ics");
        pendingTasks.forEach((t) => (t.calAdded = true));
        pendingRoutines.forEach((r) => (r.calAdded = true));
        save(); closeSheet(); render();
      };
      $("#m-recal", f).onclick = () => {
        const ts = todayStr();
        const tasks = state.tasks.filter((t) => !t.done && t.due && t.remind >= 0 && parseLocal(t.due) > new Date());
        const events = state.events.filter((ev) => ev.remind >= 0 && (ev.repeat === "weekly" || ev.date >= ts));
        const plans = Object.entries(state.plans).filter(([d]) => d >= ts)
          .flatMap(([d, ps]) => ps.filter((p) => !p.done && p.calAdded).map((p) => [d, p]));
        const n2 = tasks.length + state.routines.length + events.length + plans.length;
        if (!n2) { toast("登録する通知がありません"); return; }
        if (!confirm(`${n2}件の通知をカレンダーに登録し直します。\n先にiPhoneのカレンダーから、前に追加した予定を消しておくと重複しません。`)) return;
        openIcs(buildIcs([...tasks.flatMap(taskEvent), ...state.routines.flatMap(routineEvent),
          ...events.flatMap(eventEvent), ...plans.flatMap(([d, p]) => planEvent(d, p))]), "shinchoku-all.ics");
        [...tasks, ...state.routines, ...events].forEach((x) => (x.calAdded = true));
        save(); closeSheet(); render();
      };
      $("#m-export", f).onclick = async () => {
        const json = JSON.stringify({ app: "shinchoku-note", version: 2, exportedAt: new Date().toISOString(), ...state }, null, 2);
        const file = new File([json], `shinchoku-backup-${todayStr()}.json`, { type: "application/json" });
        if (navigator.canShare && navigator.canShare({ files: [file] })) {
          try { await navigator.share({ files: [file], title: "しんちょくノート バックアップ" }); return; } catch (e) { if (e.name === "AbortError") return; }
        }
        const a = document.createElement("a");
        a.href = URL.createObjectURL(file); a.download = file.name; a.click();
      };
      $("#m-import", f).onclick = () => $("#m-file", f).click();
      $("#m-file", f).onchange = async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        try {
          const d = JSON.parse(await file.text());
          if (!Array.isArray(d.tasks) || !Array.isArray(d.routines)) throw new Error("bad");
          if (!confirm(`タスク${d.tasks.length}件・ルーティン${d.routines.length}件で上書きします。よろしいですか？`)) return;
          state = migrate(d); save(); closeSheet(); render(); toast("復元しました");
        } catch (err) { toast("バックアップファイルを読み込めませんでした"); }
      };
      $("#m-clear", f).onclick = () => {
        const n2 = state.tasks.filter((t) => t.done).length;
        if (!n2) { toast("完了したタスクはありません"); return; }
        if (!confirm(`完了したタスク${n2}件を削除しますか？`)) return;
        state.tasks = state.tasks.filter((t) => !t.done); save(); closeSheet(); render(); toast(`${n2}件を整理しました`);
      };
    });
  }

  /* ---------- 予定（イベント） ---------- */
  const EST_OPTS = [15, 30, 45, 60, 90, 120, 180, 240];
  function durText(m) { return m < 60 ? `${m}分` : `${Math.floor(m / 60)}時間${m % 60 ? (m % 60) + "分" : ""}`; }
  const fmtMin = (m) => { m = Math.min(Math.max(m, 0), 1439); return `${pad(Math.floor(m / 60))}:${pad(m % 60)}`; };
  const icsDate = (d) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
  const endMin = (start, end) => (toMin(end) > toMin(start) ? toMin(end) : 1440);
  function eventOn(ev, ds) {
    if (ev.repeat === "weekly") return ds >= ev.date && parseDay(ds).getDay() === parseDay(ev.date).getDay();
    return ev.date === ds;
  }
  function eventsOn(ds) {
    return state.events.filter((ev) => eventOn(ev, ds))
      .sort((a, b) => (a.allDay ? "" : a.start).localeCompare(b.allDay ? "" : b.start));
  }
  function eventCard(ev) {
    const meta = (ev.place ? `<span>📍 ${esc(ev.place)}</span>` : "") +
      (ev.repeat === "weekly" ? `<span class="badge">毎週${WD[parseDay(ev.date).getDay()]}曜</span>` : "") +
      (ev.calAdded ? `<span class="badge bell">🔔通知</span>` : "") + (ev.memo ? `<span>📝 メモあり</span>` : "");
    return `<div class="card evcard" data-event="${ev.id}">
      <div class="ev-time">${ev.allDay ? "終日" : `${ev.start}<small>${ev.end}</small>`}</div>
      <div class="body"><div class="title">${esc(ev.title)}</div>${meta ? `<div class="meta">${meta}</div>` : ""}</div></div>`;
  }
  function eventEvent(ev) {
    const lines = ["BEGIN:VEVENT", `UID:event-${ev.id}@shinchoku-note`, `DTSTAMP:${icsUtc(new Date())}`];
    const d = parseDay(ev.date);
    if (ev.allDay) lines.push(`DTSTART;VALUE=DATE:${icsDate(d)}`, `DTEND;VALUE=DATE:${icsDate(addDays(d, 1))}`);
    else {
      const s = new Date(`${ev.date}T${ev.start}`);
      const m = endMin(ev.start, ev.end) - toMin(ev.start);
      lines.push(dt("DTSTART", s), dt("DTEND", new Date(s.getTime() + m * 60000)));
    }
    if (ev.repeat === "weekly") lines.push("RRULE:FREQ=WEEKLY");
    lines.push(`SUMMARY:${icsEsc(ev.title)}`);
    if (ev.place) lines.push(`LOCATION:${icsEsc(ev.place)}`);
    if (ev.memo) lines.push(`DESCRIPTION:${icsEsc(ev.memo)}`);
    if (ev.remind >= 0) {
      if (ev.allDay) lines.push("BEGIN:VALARM", "ACTION:DISPLAY", `DESCRIPTION:${icsEsc(ev.title)}`,
        ev.remind >= 1440 ? "TRIGGER:-PT15H" : "TRIGGER:PT8H", "END:VALARM"); // 前日9時 / 当日8時
      else lines.push(...alarm(`${ev.start}〜 ${ev.title}`, ev.remind));
    }
    lines.push("END:VEVENT");
    return lines;
  }
  function planEvent(ds, p) {
    const s = new Date(`${ds}T${p.start}`);
    const m = endMin(p.start, p.end) - toMin(p.start);
    return ["BEGIN:VEVENT", `UID:plan-${p.id}@shinchoku-note`, `DTSTAMP:${icsUtc(new Date())}`,
      dt("DTSTART", s), dt("DTEND", new Date(s.getTime() + m * 60000)),
      `SUMMARY:${icsEsc("✅ " + p.title)}`, ...alarm(`Todoの時間です：${p.title}`, 0), "END:VEVENT"];
  }

  function eventSheet(ev, presetDate) {
    const isNew = !ev;
    if (!ev) {
      const ds = presetDate || todayStr();
      let st = "10:00";
      if (ds === todayStr()) { const n = new Date(); st = fmtMin(Math.min((n.getHours() + 1) * 60, 1380)); }
      ev = { id: uid(), title: "", date: ds, allDay: false, start: st, end: addMinutes(st, 60), place: "", repeat: "none", remind: 30, memo: "", calAdded: false };
    }
    const remindOpts = [[-1, "通知しない"], [0, "開始の時刻"], [10, "10分前"], [30, "30分前"], [60, "1時間前"], [1440, "前日"]]
      .map(([v, l]) => `<option value="${v}" ${ev.remind === v ? "selected" : ""}>${l}</option>`).join("");
    openSheet(`
      <h2>${isNew ? "予定を追加" : "予定を編集"}</h2>
      <div class="field"><label for="e-title">予定</label>
        <input type="text" id="e-title" value="${esc(ev.title)}" placeholder="例：歯医者・バイト・授業" autocomplete="off" required></div>
      <div class="field"><label for="e-date">日付</label><input type="date" id="e-date" value="${ev.date}" required></div>
      <label class="switch"><input type="checkbox" id="e-allday" ${ev.allDay ? "checked" : ""}><span>終日</span></label>
      <div class="field" id="e-time-field"><span class="label">時間</span>
        <div class="row2 time-range"><label class="mini">開始<input type="time" id="e-start" value="${ev.start}"></label>
          <label class="mini">終了<input type="time" id="e-end" value="${ev.end}"></label></div>
        <div class="quick"><button type="button" class="chip" data-len="30">30分</button><button type="button" class="chip" data-len="60">1時間</button>
          <button type="button" class="chip" data-len="120">2時間</button><button type="button" class="chip" data-len="240">4時間</button></div></div>
      <div class="field"><label for="e-place">場所</label><input type="text" id="e-place" value="${esc(ev.place)}" placeholder="任意" autocomplete="off"></div>
      <div class="row2">
        <div class="field"><label for="e-repeat">くり返し</label><select id="e-repeat">
          <option value="none" ${ev.repeat !== "weekly" ? "selected" : ""}>しない</option>
          <option value="weekly" ${ev.repeat === "weekly" ? "selected" : ""}>毎週</option></select></div>
        <div class="field"><label for="e-remind">通知</label><select id="e-remind">${remindOpts}</select></div>
      </div>
      <div class="field"><label for="e-memo">メモ</label><textarea id="e-memo" placeholder="任意">${esc(ev.memo)}</textarea></div>
      <div class="actions">
        ${isNew ? "" : `<button type="button" class="btn danger" id="e-del">削除</button>`}
        <button type="button" class="btn" id="e-cancel">キャンセル</button>
        <button type="submit" class="btn primary">保存</button>
      </div>`,
    (f) => {
      const sI = $("#e-start", f), eI = $("#e-end", f), ad = $("#e-allday", f);
      let len = endMin(ev.start, ev.end) - toMin(ev.start);
      const paint = () => { $("#e-time-field", f).hidden = ad.checked; };
      paint();
      ad.onchange = paint;
      sI.onchange = () => { if (sI.value) eI.value = addMinutes(sI.value, len); };
      eI.onchange = () => { if (sI.value && eI.value) len = (toMin(eI.value) - toMin(sI.value) + 1440) % 1440 || 60; };
      f.querySelectorAll("[data-len]").forEach((b) => b.onclick = () => { len = Number(b.dataset.len); eI.value = addMinutes(sI.value || "10:00", len); });
      $("#e-cancel", f).onclick = closeSheet;
      if (!isNew) $("#e-del", f).onclick = () => {
        if (!confirm(`「${ev.title}」を削除しますか？` + (ev.calAdded ? "\n※カレンダーに追加した予定は、カレンダーアプリから削除してください。" : ""))) return;
        state.events = state.events.filter((x) => x.id !== ev.id); save(); closeSheet(); render();
      };
      f.onsubmit = (e) => {
        e.preventDefault();
        const title = $("#e-title", f).value.trim();
        if (!title) { $("#e-title", f).focus(); return; }
        const date = $("#e-date", f).value || todayStr();
        const start = sI.value || "10:00";
        const end = eI.value || addMinutes(start, 60);
        if (!ad.checked && end === start) { toast("終了時刻を開始時刻と別にしてください"); return; }
        const next = { title, date, allDay: ad.checked, start, end, place: $("#e-place", f).value.trim(),
          repeat: $("#e-repeat", f).value, remind: Number($("#e-remind", f).value), memo: $("#e-memo", f).value.trim() };
        const changed = ["title", "date", "allDay", "start", "end", "repeat", "remind"].some((k) => next[k] !== ev[k]);
        Object.assign(ev, next);
        if (changed && !isNew) ev.calAdded = false;
        if (isNew) state.events.push(ev);
        save(); render();
        if (ev.remind >= 0 && !ev.calAdded && (ev.repeat === "weekly" || ev.date >= todayStr())) {
          calPrompt(() => { openIcs(buildIcs(eventEvent(ev)), `event-${ev.id}.ics`); ev.calAdded = true; save(); render(); }, changed && !isNew);
        } else closeSheet();
      };
      setTimeout(() => { if (isNew) $("#e-title", f).focus(); }, 50);
    });
  }

  function addChooser(ds) {
    const d = parseDay(ds);
    openSheet(`
      <h2>${d.getMonth() + 1}月${d.getDate()}日（${WD[d.getDay()]}）に追加</h2>
      <div class="menu-list">
        <button type="button" class="btn big" data-c="event">📅 予定<small>時間が決まっている用事（授業・バイト・約束など）</small></button>
        <button type="button" class="btn big" data-c="task">✅ タスク<small>期限までに終わらせること</small></button>
        <button type="button" class="btn big" data-c="routine">🔁 ルーティン<small>毎日・毎週くり返す習慣</small></button>
      </div>
      <div class="actions"><button type="button" class="btn" id="c-close">閉じる</button></div>`,
    (f) => {
      f.onsubmit = (e) => e.preventDefault();
      $("#c-close", f).onclick = closeSheet;
      f.querySelectorAll("[data-c]").forEach((b) => b.onclick = () => {
        const c = b.dataset.c;
        if (c === "event") eventSheet(null, ds);
        else if (c === "task") taskSheet(null, ds);
        else routineSheet();
      });
    });
  }

  /* ---------- スケジュール表とTodo提案 ---------- */
  // その日の時間が決まっているもの（予定・ルーティン・Todo）を時刻順に
  function dayItems(ds) {
    const d = parseDay(ds);
    const items = [];
    eventsOn(ds).filter((ev) => !ev.allDay).forEach((ev) =>
      items.push({ kind: "event", id: ev.id, title: ev.title, start: ev.start, end: ev.end, s: toMin(ev.start), e: endMin(ev.start, ev.end), done: false, sub: ev.place }));
    state.routines.filter((r) => isScheduled(r, d)).forEach((r) =>
      items.push({ kind: "routine", id: r.id, title: r.title, start: r.time, end: r.end, s: toMin(r.time), e: endMin(r.time, r.end), done: isDoneOn(r, ds) }));
    (state.plans[ds] || []).forEach((p) =>
      items.push({ kind: "plan", id: p.id, title: p.title, start: p.start, end: p.end, s: toMin(p.start), e: endMin(p.start, p.end), done: p.done, sub: p.reason }));
    return items.sort((a, b) => a.s - b.s || b.e - a.e);
  }

  function dayWindow(ds) {
    let from = toMin(state.settings.wake), to = toMin(state.settings.sleep);
    if (to <= from) to = 1440;
    if (ds === todayStr()) {
      const n = new Date();
      from = Math.max(from, Math.ceil((n.getHours() * 60 + n.getMinutes() + 5) / 15) * 15);
    }
    return [from, to];
  }
  function freeSlots(ds, extraBusy = []) {
    const [from, to] = dayWindow(ds);
    const busy = [...dayItems(ds), ...extraBusy].map((i) => [i.s, i.e]).sort((a, b) => a[0] - b[0]);
    const slots = [];
    let cur = from;
    busy.forEach(([s, e]) => {
      if (s > cur) slots.push([cur, Math.min(s, to)]);
      cur = Math.max(cur, e);
    });
    if (cur < to) slots.push([cur, to]);
    return slots.filter(([s, e]) => e - s >= 15);
  }

  // 期限の近さ・遅れ具合からTodoの優先度を決めて、空き時間に入れていく
  function suggest(ds, only) {
    const day = parseDay(ds);
    const endOfDay = addDays(day, 1);
    const isToday = ds === todayStr();
    const ref = isToday ? new Date() : day;
    const planned = new Set((state.plans[ds] || []).map((p) => `${p.taskId}|${p.stepId || ""}`));
    const cands = state.tasks.filter((t) => !t.done && !(isLong(t) && t.start && t.start > ds)).map((t) => {
      const due = parseLocal(t.due);
      let score, reason;
      if (due && due < ref) { score = 1000; reason = "期限切れ"; }
      else if (due && due < endOfDay) { score = 900; reason = isToday ? "今日が期限" : "この日が期限"; }
      else if (due) {
        const dl = Math.ceil((due - endOfDay) / 86400000);
        const pc = pace(t);
        if (isLong(t) && pc && pc.cls === "danger") { score = 650; reason = "長期・遅れ気味"; }
        else if (isLong(t) && pc && pc.cls === "warn") { score = 550; reason = "長期・やや遅れ"; }
        else if (isLong(t)) { score = Math.max(150, 320 - dl); reason = `長期・期限まで${dl + 1}日`; }
        else { score = dl <= 2 ? 800 - dl * 50 : Math.max(200, 450 - dl * 5); reason = `期限まで${dl + 1}日`; }
      } else { score = 100 + (t.progress || 0) / 10; reason = "期限なし"; }
      let title = t.title, stepId = "";
      if (isLong(t)) {
        const s = t.steps.find((x) => !x.done);
        if (s) { title = `${t.title}：${s.title}`; stepId = s.id; }
      }
      return { t, score, reason, title, stepId, dur: t.est || 60 };
    }).filter((c) => !planned.has(`${c.t.id}|${c.stepId}`) && (!only || c.t.id === only)).sort((a, b) => b.score - a.score);

    const slots = freeSlots(ds);
    const out = [];
    const GAP = 10; // Todoの間に少し休憩をはさむ
    for (const c of cands) {
      if (out.length >= 6) break;
      for (const slot of slots) {
        const len = slot[1] - slot[0];
        if (len >= c.dur || (len >= 30 && c.score >= 800)) {
          const d = Math.min(c.dur, len);
          out.push({ id: uid(), taskId: c.t.id, stepId: c.stepId, title: c.title, reason: c.reason + (d < c.dur ? "・途中まで" : ""),
            start: fmtMin(slot[0]), end: fmtMin(slot[0] + d), done: false });
          slot[0] += d + GAP;
          break;
        }
      }
    }
    return out.sort((a, b) => a.start.localeCompare(b.start));
  }

  function togglePlan(ds, id) {
    const p = (state.plans[ds] || []).find((x) => x.id === id);
    if (!p) return;
    p.done = !p.done;
    const t = state.tasks.find((x) => x.id === p.taskId);
    if (t && p.stepId) {
      const s = t.steps.find((x) => x.id === p.stepId);
      if (s) s.done = p.done;
      if (p.done && t.steps.every((x) => x.done) && !t.done) { t.done = true; t.doneAt = Date.now(); toast("ステップが全部おわりました 🎉"); }
      else if (p.done) toast("ステップを1つ進めました！");
    } else if (p.done && t && !t.done) toast("おつかれさま！タスクが終わったらタスクにもチェックを");
    save(); render();
  }

  function planSheet(ds, id) {
    const p = (state.plans[ds] || []).find((x) => x.id === id);
    if (!p) return;
    const t = state.tasks.find((x) => x.id === p.taskId);
    openSheet(`
      <h2>Todo</h2>
      <p style="margin:0;font-weight:700">${esc(p.title)}</p>
      ${p.reason ? `<p class="note">提案の理由：${esc(p.reason)}</p>` : ""}
      <div class="field"><span class="label">時間</span>
        <div class="row2 time-range"><label class="mini">開始<input type="time" id="p-start" value="${p.start}"></label>
          <label class="mini">終了<input type="time" id="p-end" value="${p.end}"></label></div></div>
      <div class="menu-list">
        <button type="button" class="btn" id="p-done">${p.done ? "↩︎ 未完了にもどす" : "✅ やった！"}</button>
        ${t ? `<button type="button" class="btn" id="p-task">📝 元のタスクを開く</button>` : ""}
      </div>
      <div class="actions">
        <button type="button" class="btn danger" id="p-del">外す</button>
        <button type="button" class="btn" id="p-cancel">キャンセル</button>
        <button type="submit" class="btn primary">保存</button>
      </div>`,
    (f) => {
      $("#p-cancel", f).onclick = closeSheet;
      $("#p-done", f).onclick = () => { closeSheet(); togglePlan(ds, id); };
      if (t) $("#p-task", f).onclick = () => taskSheet(t);
      $("#p-del", f).onclick = () => {
        state.plans[ds] = state.plans[ds].filter((x) => x.id !== id);
        save(); closeSheet(); render(); toast(p.calAdded ? "外しました（カレンダーの通知は手動で削除してください）" : "スケジュールから外しました");
      };
      f.onsubmit = (e) => {
        e.preventDefault();
        const s = $("#p-start", f).value, en = $("#p-end", f).value;
        if (!s || !en || s === en) { toast("時間を正しく入れてください"); return; }
        if (s !== p.start || en !== p.end) p.calAdded = false;
        Object.assign(p, { start: s, end: en });
        save(); closeSheet(); render();
      };
    });
  }

  function dayTaskPanel(ds, sug) {
    const ts = todayStr();
    const d = parseDay(ds);
    const lim = ymd(addDays(d, 3));
    const list = state.tasks.filter((t) => !t.done && t.due && !(isLong(t) && t.start && t.start > ds)).filter((t) => {
      const dd = t.due.slice(0, 10);
      if (isLong(t)) return dd >= ds;
      return (ds === ts && dd < ds) || (dd >= ds && dd <= lim);
    }).sort((a, b) => a.due.localeCompare(b.due));
    const planned = {};
    (state.plans[ds] || []).forEach((p) => { if (!planned[p.taskId]) planned[p.taskId] = p; });
    const sugBy = {};
    sug.forEach((b) => { const o = suggestion.blocks.find((x) => x.id === b.id); if (o && !sugBy[o.taskId]) sugBy[o.taskId] = o; });
    const rows = list.map((t) => {
      const due = parseLocal(t.due);
      const r = remaining(due);
      const step = isLong(t) ? t.steps.find((x) => !x.done) : null;
      const p = planned[t.id], sg = sugBy[t.id];
      const right = p ? `<span class="badge bell">📌 ${p.start}〜</span>`
        : sg ? `<span class="badge">💡 ${sg.start}〜</span>`
        : `<button class="chip dt-place" data-place="${t.id}">＋入れる</button>`;
      return `<div class="dt-row ${isLong(t) ? "long" : ""}" data-task="${t.id}" ${isLong(t) ? `style="--c:${longColor(t)}"` : ""}>
        <button class="check sm" data-toggle-task="${t.id}" aria-label="完了にする">${CHECK_SVG}</button>
        <div class="dt-body"><b>${esc(t.title)}</b>
          <small>〆 ${fmtDue(due)}・<span class="${r.cls}">${r.text}</span>${step ? `・次：${esc(step.title)}` : ""}</small></div>
        ${right}</div>`;
    }).join("");
    return `<section class="day-tasks">
      <div class="dt-head">📝 ${ds === ts ? "今日" : "この日"}のタスク <small>${list.length}件</small></div>
      ${list.length ? rows : `<p class="note">期限が近いタスクはありません</p>`}
    </section>`;
  }

  function renderSchedule() {
    const ds = schedDate;
    const d = parseDay(ds);
    const ts = todayStr();
    // 最初から空き時間にTodoを入れた案を見せる（まだ何も決めていない日だけ）
    if ((!suggestion || suggestion.date !== ds) && ds >= ts && !(state.plans[ds] || []).length && !autoOff.has(ds)) {
      const bl = suggest(ds);
      suggestion = bl.length ? { date: ds, blocks: bl, auto: true } : null;
      if (!bl.length) autoOff.add(ds);
    }
    const items = dayItems(ds);
    const sug = suggestion && suggestion.date === ds
      ? suggestion.blocks.map((b) => ({ kind: "sug", id: b.id, title: b.title, start: b.start, end: b.end, s: toMin(b.start), e: endMin(b.start, b.end), sub: b.reason }))
      : [];
    const all = [...items, ...sug].sort((a, b) => a.s - b.s || b.e - a.e);
    const allDay = eventsOn(ds).filter((ev) => ev.allDay);

    let [from, to] = [toMin(state.settings.wake), toMin(state.settings.sleep)];
    if (to <= from) to = 1440;
    all.forEach((i) => { from = Math.min(from, i.s); to = Math.max(to, i.e); });
    const dueHere = state.tasks.filter((t) => !t.done && t.due && t.due.slice(0, 10) === ds);
    dueHere.forEach((t) => { const m = toMin(t.due.slice(11, 16)); from = Math.min(from, m); to = Math.max(to, m + 30); });
    from = Math.floor(from / 60) * 60;
    to = Math.min(1440, Math.ceil(to / 60) * 60);
    const PX = 1.1; // 1分あたりのピクセル

    // 重なる予定は横に並べる
    let cluster = null;
    all.forEach((i) => {
      if (!cluster || i.s >= cluster.end) cluster = { end: i.e, items: [], lanes: [] };
      cluster.end = Math.max(cluster.end, i.e);
      let l = cluster.lanes.findIndex((e) => e <= i.s);
      if (l < 0) { l = cluster.lanes.length; cluster.lanes.push(0); }
      cluster.lanes[l] = i.e;
      i.lane = l; i.cluster = cluster;
    });

    let hours = "";
    for (let h = from / 60; h <= to / 60; h++) {
      hours += `<div class="tl-hour" style="top:${(h * 60 - from) * PX}px"><span>${h}:00</span></div>`;
    }
    const kindName = { event: "予定", routine: "ルーティン", plan: "Todo", sug: "提案" };
    const blocks = all.map((i) => {
      const n = i.cluster.lanes.length;
      const h = Math.max((i.e - i.s) * PX, 24);
      const attr = i.kind === "event" ? `data-event="${i.id}"` : i.kind === "routine" ? `data-routine="${i.id}"`
        : i.kind === "plan" ? `data-plan="${i.id}"` : `data-sug="${i.id}"`;
      const check = i.kind === "plan" ? `<button class="check sm ${i.done ? "on" : ""}" data-plan-check="${i.id}" aria-label="やった">${CHECK_SVG}</button>`
        : i.kind === "routine" && ds <= ts ? `<button class="check sm ${i.done ? "on" : ""}" data-toggle-routine="${i.id}" data-date="${ds}" aria-label="やった">${CHECK_SVG}</button>` : "";
      return `<div class="tl-block ${i.kind} ${i.done ? "done" : ""} ${h < 44 ? "short" : ""}" ${attr}
          style="top:${(i.s - from) * PX}px;height:${h - 2}px;left:calc(46px + (100% - 50px) * ${i.lane} / ${n});width:calc((100% - 50px) / ${n} - 3px)">
        ${check}<div class="tl-text"><b>${esc(i.title)}</b><small>${i.start}〜${i.end === "23:59" ? "24:00" : i.end}・${kindName[i.kind]}${i.sub ? "・" + esc(i.sub) : ""}</small></div></div>`;
    }).join("");
    const dueLines = dueHere.map((t) => {
      const m = toMin(t.due.slice(11, 16));
      return `<div class="tl-due" style="top:${(m - from) * PX}px" data-task="${t.id}"><span>〆 ${t.due.slice(11, 16)} ${esc(t.title)}</span></div>`;
    }).join("");
    let nowLine = "";
    if (ds === ts) {
      const n = new Date();
      const m = n.getHours() * 60 + n.getMinutes();
      if (m >= from && m <= to) nowLine = `<div class="tl-now" style="top:${(m - from) * PX}px"></div>`;
    }

    const free = freeSlots(ds, sug).reduce((s, [a, b]) => s + b - a, 0);
    const plans = state.plans[ds] || [];
    const plansNeedCal = plans.some((p) => !p.done && !p.calAdded) && ds >= ts;
    const sugBox = sug.length ? `
      <section class="sug-box">
        <b>💡 ${suggestion.auto ? "空き時間にタスクを入れてみました" : "おすすめのTodo"}（${sug.length}件）</b>
        <p class="note">期限が近いもの・遅れているものから入れています。点線の枠が提案です。いらないものはタップで外して、「決定」で確定します。</p>
        <div class="actions"><button class="btn" data-sug-cancel>今日はいいや</button><button class="btn primary" data-sug-accept>この内容で決定</button></div>
      </section>`
      : `<button class="btn primary wide" data-suggest>💡 ${ds === ts ? "今日" : "この日"}のTodoを提案して</button>`;

    main.innerHTML = `
      <div class="sched-head">
        <button class="icon-btn sm" data-sched-move="-1" aria-label="前の日">‹</button>
        <div><b>${d.getMonth() + 1}月${d.getDate()}日（${WD[d.getDay()]}）</b>${ds === ts ? `<span class="badge bell">今日</span>` : `<button class="text-btn" data-sched-today>今日へ</button>`}</div>
        <button class="icon-btn sm" data-sched-move="1" aria-label="次の日">›</button>
      </div>
      <p class="note sched-note">空き時間 ${durText(free) || "0分"}（${state.settings.wake}〜${state.settings.sleep}で計算）</p>
      ${sugBox}
      ${plansNeedCal && !sug.length ? `<button class="btn cal" data-plan-cal>🔔 Todoの時刻に通知する</button>` : ""}
      ${allDay.length ? `<div class="allday">${allDay.map((ev) => `<button class="chip ev" data-event="${ev.id}">終日・${esc(ev.title)}</button>`).join("")}</div>` : ""}
      ${dayTaskPanel(ds, sug)}
      <section class="timeline" style="height:${(to - from) * PX + 16}px">${hours}${blocks}${dueLines}${nowLine}</section>
      ${!all.length ? `<p class="note" style="text-align:center;margin-top:10px">右下の ＋ から予定を入れるか、「Todoを提案して」を押してみてください</p>` : ""}`;
  }

  /* ---------- テーマ（自動・白・黒） ---------- */
  function applyTheme() {
    const t = state.settings.theme;
    if (t === "light" || t === "dark") document.documentElement.dataset.theme = t;
    else delete document.documentElement.dataset.theme;
    const look = ["modern", "cyber", "kotan"].includes(state.settings.look) ? state.settings.look : "memo";
    const modern = look === "modern";
    document.documentElement.dataset.look = look;
    const dark = t === "dark" || (t !== "light" && window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches);
    document.querySelectorAll('meta[name="theme-color"]').forEach((m) => m.setAttribute("content", look === "cyber" ? "#05060d" : look === "kotan" ? (dark ? "#1a120c" : "#fff8f1") : modern ? (dark ? "#0d0e12" : "#f3f4f8") : (dark ? "#23262b" : "#fffbea")));
  }
  applyTheme();
  if (window.matchMedia) window.matchMedia("(prefers-color-scheme: dark)").addEventListener?.("change", applyTheme);

  /* ---------- 演出（パラパラ漫画っぽい動き） ---------- */
  const reduceMotion = !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  const INKS_MEMO = ["#e8413a", "#2f6fd6", "#ffbf1a", "#22a06b", "#ff6fb0"];
  const INKS_KOTAN = ["#ff6a1a", "#ffb02e", "#ff8f6b", "#ffd23d", "#ff4f3a"];
  const INKS_CYBER = ["#00e5ff", "#7df9ff", "#2f8bff", "#b8f6ff", "#39ff9f"];
  const PRAISE = ["できた！", "えらい！", "ナイス！", "すごい！", "やったね！"];
  let enterTimer, slideTimer;
  const fx = {
    // 押したボタンの真ん中（描き直す前に取っておく）
    point(e) {
      const b = e && e.target && e.target.closest && e.target.closest("button, .card, .dt-row");
      if (b) { const r = b.getBoundingClientRect(); return [r.left + Math.min(r.width / 2, 40), r.top + r.height / 2]; }
      return [(e && e.clientX) || innerWidth / 2, (e && e.clientY) || innerHeight / 2];
    },
    // 線・星・丸がはじける
    burst(x, y, big) {
      if (reduceMotion) return;
      const n = big ? 14 : 9;
      const el = document.createElement("div");
      el.className = "burst";
      el.style.left = x + "px"; el.style.top = y + "px";
      let html = "";
      for (let i = 0; i < n; i++) {
        const a = (360 / n) * i + Math.random() * 18;
        const dist = (big ? 54 : 34) + Math.random() * 20;
        const lk = document.documentElement.dataset.look;
        const inks = lk === "cyber" ? INKS_CYBER : lk === "kotan" ? INKS_KOTAN : INKS_MEMO;
        html += `<i class="b${i % 3}" style="--a:${a}deg;--d:${dist}px;--c:${inks[i % inks.length]}"></i>`;
      }
      el.innerHTML = html;
      document.body.appendChild(el);
      setTimeout(() => el.remove(), 900);
    },
    // サイバーのとき、見出しがノイズで一瞬乱れる
    glitch() {
      if (reduceMotion || document.documentElement.dataset.look !== "cyber") return;
      const h = $("#screen-title");
      h.classList.remove("glitch"); void h.offsetWidth; h.classList.add("glitch");
      setTimeout(() => h.classList.remove("glitch"), 500);
    },
    // ハンコがポンと押される
    stamp(text) {
      if (reduceMotion) return;
      fx.glitch();
      document.querySelectorAll(".stamp").forEach((x) => x.remove());
      const el = document.createElement("div");
      el.className = "stamp";
      el.textContent = text || PRAISE[Math.floor(Math.random() * PRAISE.length)];
      el.style.setProperty("--r", `${-12 + Math.random() * 10}deg`);
      document.body.appendChild(el);
      setTimeout(() => el.remove(), 1300);
    },
    // ページをめくったとき、前のページがうっすら残って消える（オニオンスキン）
    onion(oldHTML) {
      if (reduceMotion || !oldHTML) return;
      const g = document.createElement("div");
      g.className = "onion";
      g.setAttribute("aria-hidden", "true");
      g.innerHTML = oldHTML;
      main.appendChild(g);
      setTimeout(() => g.remove(), 520);
      fx.enter();
    },
    enter() {
      if (reduceMotion) return;
      main.classList.remove("enter"); void main.offsetWidth; main.classList.add("enter");
      clearTimeout(enterTimer); enterTimer = setTimeout(() => main.classList.remove("enter"), 900);
    },
    slide(dir) {
      if (reduceMotion) return;
      main.classList.remove("slide-l", "slide-r"); void main.offsetWidth;
      main.classList.add(dir > 0 ? "slide-l" : "slide-r");
      clearTimeout(slideTimer); slideTimer = setTimeout(() => main.classList.remove("slide-l", "slide-r"), 500);
    },
    // 描き直したあとのチェックに「描く」アニメーションをつける
    mark(sel) { const el = main.querySelector(sel); if (el) el.classList.add("just"); },
  };
  function goTab(name) {
    const old = main.innerHTML;
    tab = name;
    render();
    window.scrollTo(0, 0);
    fx.onion(old);
    fx.glitch();
  }

  /* ---------- 操作 ---------- */
  let toastTimer;
  function toast(msg) {
    const el = $("#toast");
    el.textContent = msg; el.classList.add("show");
    clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove("show"), 2200);
  }

  main.addEventListener("click", (e) => {
    const at = fx.point(e);
    const tt = e.target.closest("[data-toggle-task]");
    if (tt) {
      const t = state.tasks.find((x) => x.id === tt.dataset.toggleTask);
      t.done = !t.done;
      t.doneAt = t.done ? Date.now() : 0;
      if (t.done) { if (!isLong(t) || !t.steps.length) t.progress = 100; if (t.calAdded) toast("カレンダーの通知は必要なら削除してください"); }
      else if (t.progress >= 100) t.progress = 90;
      save(); render();
      if (t.done) { fx.burst(at[0], at[1], true); fx.stamp(); fx.mark(`[data-toggle-task="${t.id}"]`); }
      return;
    }
    const tr = e.target.closest("[data-toggle-routine]");
    if (tr) {
      const r = state.routines.find((x) => x.id === tr.dataset.toggleRoutine);
      const ds = tr.dataset.date || todayStr();
      if (r.doneDates.includes(ds)) r.doneDates = r.doneDates.filter((d) => d !== ds);
      else { r.doneDates.push(ds); r.doneDates = r.doneDates.sort().slice(-400); }
      const nowDone = r.doneDates.includes(ds);
      save(); render();
      if (nowDone) {
        const st = streak(r);
        fx.burst(at[0], at[1], st > 1); fx.mark(`[data-toggle-routine="${r.id}"][data-date="${ds}"]`);
        if (st > 1) fx.stamp(`🔥${st}回連続！`);
      }
      return;
    }
    const f = e.target.closest("[data-filter]");
    if (f) { taskFilter = f.dataset.filter; render(); return; }
    const mv = e.target.closest("[data-cal-move]");
    if (mv) { calMonth = new Date(calMonth.getFullYear(), calMonth.getMonth() + Number(mv.dataset.calMove), 1); render(); fx.slide(Number(mv.dataset.calMove)); return; }
    if (e.target.closest("[data-cal-today]")) { calMonth = firstOfMonth(new Date()); calSelected = todayStr(); render(); return; }
    const day = e.target.closest("[data-day]");
    if (day) {
      calSelected = day.dataset.day;
      const d = parseDay(calSelected);
      if (d.getMonth() !== calMonth.getMonth()) calMonth = firstOfMonth(d);
      render(); return;
    }
    const go = e.target.closest("[data-goto]");
    if (go) { if (go.dataset.goto === "schedule") schedDate = todayStr(); goTab(go.dataset.goto); return; }
    const os = e.target.closest("[data-open-schedule]");
    if (os) { schedDate = os.dataset.openSchedule; goTab("schedule"); return; }
    const ae = e.target.closest("[data-add-event]");
    if (ae) { eventSheet(null, ae.dataset.addEvent); return; }
    const evc = e.target.closest("[data-event]");
    if (evc) { eventSheet(state.events.find((x) => x.id === evc.dataset.event)); return; }
    const sm = e.target.closest("[data-sched-move]");
    if (sm) { schedDate = ymd(addDays(parseDay(schedDate), Number(sm.dataset.schedMove))); render(); fx.slide(Number(sm.dataset.schedMove)); return; }
    if (e.target.closest("[data-sched-today]")) { schedDate = todayStr(); render(); return; }
    if (e.target.closest("[data-suggest]")) {
      const blocks = suggest(schedDate);
      suggestion = { date: schedDate, blocks };
      if (blocks.length) fx.burst(at[0], at[1]);
      if (!blocks.length) toast("入れられるTodoが見つかりませんでした");
      render(); return;
    }
    if (e.target.closest("[data-sug-accept]")) {
      state.plans[schedDate] = [...(state.plans[schedDate] || []), ...suggestion.blocks.map(({ reason, ...b }) => ({ ...b, reason }))];
      const n = suggestion.blocks.length;
      suggestion = null; save(); render(); fx.burst(at[0], at[1], true); fx.stamp("けってい！"); return;
    }
    if (e.target.closest("[data-sug-cancel]")) { autoOff.add(schedDate); suggestion = null; render(); return; }
    const pt = e.target.closest("[data-place]");
    if (pt) {
      const bl = suggest(schedDate, pt.dataset.place);
      if (!bl.length) { toast("入れられる空き時間がありませんでした"); return; }
      state.plans[schedDate] = [...(state.plans[schedDate] || []), ...bl];
      save();
      if (suggestion && suggestion.date === schedDate) suggestion.blocks = suggest(schedDate);
      render(); fx.burst(at[0], at[1]); toast(`${bl[0].start}〜に入れました`); return;
    }
    const sg = e.target.closest("[data-sug]");
    if (sg) { suggestion.blocks = suggestion.blocks.filter((b) => b.id !== sg.dataset.sug); toast("提案から外しました"); render(); return; }
    const pc = e.target.closest("[data-plan-check]");
    if (pc) {
      togglePlan(schedDate, pc.dataset.planCheck);
      const p = (state.plans[schedDate] || []).find((x) => x.id === pc.dataset.planCheck);
      if (p && p.done) { fx.burst(at[0], at[1], true); fx.stamp(); fx.mark(`[data-plan-check="${p.id}"]`); }
      return;
    }
    const pl = e.target.closest("[data-plan]");
    if (pl) { planSheet(schedDate, pl.dataset.plan); return; }
    if (e.target.closest("[data-plan-cal]")) {
      const ps = (state.plans[schedDate] || []).filter((p) => !p.done);
      openIcs(buildIcs(ps.flatMap((p) => planEvent(schedDate, p))), `schedule-${schedDate}.ics`);
      ps.forEach((p) => (p.calAdded = true)); save(); render(); return;
    }
    const ao = e.target.closest("[data-add-on]");
    if (ao) { taskSheet(null, ao.dataset.addOn); return; }
    const tc = e.target.closest("[data-task]");
    if (tc) { taskSheet(state.tasks.find((x) => x.id === tc.dataset.task)); return; }
    const rc = e.target.closest("[data-routine]");
    if (rc) { routineSheet(state.routines.find((x) => x.id === rc.dataset.routine)); }
  });

  // カレンダーは左右スワイプでも月を移動
  let touchX = null;
  main.addEventListener("touchstart", (e) => { if (tab === "calendar" && e.target.closest(".cal")) touchX = e.touches[0].clientX; }, { passive: true });
  main.addEventListener("touchend", (e) => {
    if (touchX === null) return;
    const dx = e.changedTouches[0].clientX - touchX;
    touchX = null;
    if (Math.abs(dx) > 60) { const dir = dx < 0 ? 1 : -1; calMonth = new Date(calMonth.getFullYear(), calMonth.getMonth() + dir, 1); render(); fx.slide(dir); }
  }, { passive: true });

  document.querySelectorAll(".tabs button").forEach((b) => b.onclick = () => { if (b.dataset.tab !== tab) goTab(b.dataset.tab); });
  $("#fab").onclick = () => {
    if (tab === "routines") routineSheet();
    else if (tab === "calendar" || tab === "schedule") addChooser(tab === "calendar" ? calSelected : schedDate);
    else taskSheet();
  };
  $("#menu-btn").onclick = menuSheet;

  // ホーム画面に追加していない iPhone の Safari ではヒントを出す
  const standalone = window.navigator.standalone || window.matchMedia("(display-mode: standalone)").matches;
  const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent);
  let hintClosed = false;
  try { hintClosed = localStorage.getItem("shinchoku-hint-closed") === "1"; } catch (e) { /* noop */ }
  if (isIOS && !standalone && !hintClosed) $("#install-hint").hidden = false;
  $("#hint-close").onclick = () => {
    $("#install-hint").hidden = true;
    try { localStorage.setItem("shinchoku-hint-closed", "1"); } catch (e) { /* noop */ }
  };

  // 残り時間などを定期的に更新（日付が変わったときも）
  setInterval(() => { if (!sheet.open) render(); }, 60000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden && !sheet.open) render(); });

  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});

  render();
  fx.enter();
})();
